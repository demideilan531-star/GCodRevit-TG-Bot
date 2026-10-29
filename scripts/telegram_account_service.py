"""Always-running, read-only collector; no login, bot token or public control API."""

import asyncio
import copy
import hashlib
import hmac
import json
import logging
import os
import re
import signal
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit

try:
    from . import telegram_account_sync as sync
except ImportError:
    import telegram_account_sync as sync


def credential(env, name):
    direct, filename = env.get(name), env.get(name + '_FILE')
    if direct and filename:
        raise sync.SafeError('ambiguous_configuration')
    if filename:
        try:
            with Path(filename).open('r', encoding='utf-8') as stream:
                direct = stream.read(16385).strip()
        except OSError:
            raise sync.SafeError('credential_unavailable') from None
    if not direct or len(direct) > 16384:
        raise sync.SafeError('configuration_missing')
    return direct


@dataclass(repr=False)
class ServiceConfig:
    api_id: int
    api_hash: str
    session: str
    owner: int
    origin: str
    service_id: str
    secret: str

    @classmethod
    def from_env(cls, env):
        try:
            api_id = sync.integer(int(credential(env, 'TELEGRAM_API_ID')), 1, sync.MAX_ID)
            owner = sync.integer(int(credential(env, 'TELEGRAM_ACCOUNT_OWNER_ID')), 1, (1 << 63) - 1)
        except ValueError:
            raise sync.SafeError('invalid_configuration') from None
        api_hash = credential(env, 'TELEGRAM_API_HASH')
        secret = credential(env, 'TELEGRAM_ACCOUNT_SERVICE_SECRET')
        ident = env.get('TELEGRAM_ACCOUNT_SERVICE_ID', '')
        if (not re.fullmatch(r'[0-9a-fA-F]{32}', api_hash) or
                not re.fullmatch(r'[0-9a-f]{64}', secret) or
                not re.fullmatch(r'[a-z0-9-]{3,48}', ident)):
            raise sync.SafeError('invalid_configuration')
        return cls(api_id, api_hash, credential(env, 'TELEGRAM_USER_SESSION'), owner,
                   sync.https_url(env.get('TELEGRAM_CONTEXT_BROKER_URL', ''), origin=True),
                   ident, secret)


class ServiceSigner:
    def __init__(self, secret, service_id, run=None, wall=time.time):
        self.key = bytes.fromhex(secret)
        self.service_id = service_id
        self.run = run or str(uuid.uuid4())
        self.wall = wall

    def headers(self, url, body):
        timestamp = str(int(self.wall()))
        canonical = '\n'.join(['context-service:v1', 'POST', urlsplit(url).path,
                               self.service_id, self.run, timestamp,
                               hashlib.sha256(body).hexdigest()]).encode('utf-8')
        return {'Authorization': 'Context-HMAC ' + hmac.new(self.key, canonical, hashlib.sha256).hexdigest(),
                'X-Context-Service': self.service_id, 'X-Context-Run': self.run,
                'X-Context-Timestamp': timestamp}


class ServiceTelegram(sync.ReadOnlyTelegram):
    async def disconnect(self):
        # The supervisor owns the single connection, including final shutdown.
        pass


class ServiceRunner(sync.Runner):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.last_date_checkpoint = self.budget.clock()
        self.last_lease_check = self.budget.clock()

    async def global_difference(self):
        if self.budget.clock() - self.last_lease_check >= 30:
            result = await self.broker.post('heartbeat', dict(lease_id=self.lease, generation=self.generation))
            if result.get('ok') is not True:
                raise sync.SafeError('invalid_heartbeat')
            self.quota = min(self.quota, sync.integer(result.get('quota_remaining')))
            self.last_lease_check = self.budget.clock()
        await super().global_difference()

    def history_allowed(self):
        # Reserve daily capacity for live updates/control, rather than letting
        # an old busy channel consume the whole day in the first history pass.
        return self.quota >= 21024

    async def save_update(self, value):
        old, new = copy.deepcopy(self.update), copy.deepcopy(value)
        for item in (old, new):
            item.get('global', {}).pop('date', None)
        # Empty polling must not consume a write receipt every ten seconds.
        # Only date-only changes are deferred; a crash replays from the older
        # durable date/pts. All content/seq/pts/deletion progress stays durable.
        if old == new and self.budget.clock() - self.last_date_checkpoint < 300:
            self.update = sync.state_size(value)
            return
        await super().save_update(value)
        self.last_date_checkpoint = self.budget.clock()


class Collector:
    def __init__(self, config, client, transport=None, clock=time.monotonic):
        self.config, self.client = config, client
        self.transport = transport or sync.HttpTransport()
        self.clock = clock
        self.cached = None
        self.next_discovery = 0
        self.last_progress = clock()
        self.status = 'starting'

    async def cycle(self):
        budget = sync.Budget(clock=self.clock)
        signer = ServiceSigner(self.config.secret, self.config.service_id)
        runner = ServiceRunner(ServiceTelegram(self.client, self.config.owner, budget),
                               sync.Broker(self.config.origin, signer, self.transport, budget),
                               self.config.owner, budget, live_interval=10)
        generation = None
        if self.cached:
            runner.entities, runner.peers, runner.index_records = self.cached.entities, self.cached.peers, self.cached.index_records
            if self.clock() < self.next_discovery:
                generation = self.cached.generation
        status = await runner.run(cached_generation=generation)
        self.last_progress = self.clock()
        if runner._gap_finish_body:
            status = 'reconciliation_required'
        self.status = status
        if status == 'idle':
            self.cached = runner
            if generation is None and not runner.cursor:
                self.next_discovery = self.clock() + 21600
        else:
            self.cached = None
            try:
                await asyncio.wait_for(self.client.disconnect(), 5)
            except Exception:
                pass
        return status, runner.retry_after_seconds, runner.last_http_status


def retry_delay(status, retry=None, failures=0, now=None):
    if retry is not None:
        # A failed broker finish must not shorten an observed Telegram wait.
        return max(1, int(retry))
    if status == 'flood_wait':
        return 1
    if status == 'quota':
        now = now or datetime.now(timezone.utc)
        tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        return max(1, int((tomorrow - now).total_seconds()) + 5)
    if status == 'idle':
        return 1
    return min(900, 60 * (2 ** min(max(failures - 1, 0), 4)))


async def supervise(collector, stop):
    failures = 0
    while not stop.is_set():
        collector.status = 'syncing'
        task = asyncio.create_task(collector.cycle())
        stopped = asyncio.create_task(stop.wait())
        try:
            done, _ = await asyncio.wait([task, stopped], timeout=475, return_when=asyncio.FIRST_COMPLETED)
            if stopped in done or task not in done:
                task.cancel()
                try:
                    await asyncio.wait_for(task, 15)
                except (Exception, asyncio.CancelledError):
                    pass
                if stop.is_set():
                    break
                status, retry, http = 'error', None, None
            else:
                try:
                    status, retry, http = task.result()
                except Exception:
                    status, retry, http = 'error', None, None
            failures = failures + 1 if status == 'error' else 0
            collector.status = status
            # Fixed labels only: never print remote exceptions, bodies or keys.
            print('Account collector: ' + status, flush=True)
            if status == 'reconciliation_required' or http in (401, 403):
                await stop.wait()
                break
            delay = retry_delay(status, retry, failures)
            try:
                await asyncio.wait_for(stop.wait(), delay)
            except asyncio.TimeoutError:
                pass
        finally:
            stopped.cancel()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, stopped, return_exceptions=True)


def health_handler(collector):
    class Health(BaseHTTPRequestHandler):
        server_version = 'Collector'

        def do_GET(self):
            if self.path != '/healthz':
                self.send_error(404)
                return
            healthy = (collector.status in ('quota', 'flood_wait') or
                       (collector.status in ('starting', 'syncing', 'idle') and
                        collector.clock() - collector.last_progress < 720))
            payload = json.dumps({'healthy': healthy, 'status': collector.status}).encode('ascii')
            self.send_response(200 if healthy else 503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass
    return Health


async def async_main():
    if sync.telethon_version != '1.45.0':
        raise sync.SafeError('unsupported_telethon_version')
    config = ServiceConfig.from_env(os.environ)
    session = sync.StringSession(config.session)
    if not session.auth_key:
        raise sync.SafeError('session_missing')
    client = sync.VerifiedClient(config.owner, session, config.api_id, config.api_hash,
                                 receive_updates=False, catch_up=False, flood_sleep_threshold=0,
                                 request_retries=0, connection_retries=1, auto_reconnect=False,
                                 timeout=10, raise_last_call_error=True)
    collector, stop = Collector(config, client), asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    bind = os.environ.get('COLLECTOR_HEALTH_BIND', '127.0.0.1')
    server = ThreadingHTTPServer((bind, 8080), health_handler(collector))
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        await supervise(collector, stop)
    finally:
        try:
            await asyncio.wait_for(client.disconnect(), 5)
        finally:
            server.shutdown()
            server.server_close()


def main():
    logging.disable(logging.CRITICAL)
    try:
        asyncio.run(async_main())
        return 0
    except (Exception, KeyboardInterrupt):
        print('Account collector: setup_or_runtime_error', flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
