"""Service lifecycle/auth tests: no Telegram, Cloudflare or external sockets."""

import asyncio
import copy
import hashlib
import hmac
import io
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from scripts import telegram_account_service as service
from scripts import telegram_account_sync as sync


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now

    async def sleep(self, seconds):
        self.now += seconds


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.clock = Clock()
        self.budget = sync.Budget(450, clock=self.clock, sleep=self.clock.sleep)

    async def test_empty_polling_does_not_consume_write_budget_every_ten_seconds(self):
        broker = SimpleNamespace(post=AsyncMock(return_value={'ok': True, 'quota_remaining': 45000}))
        runner = service.ServiceRunner(None, broker, 1, self.budget)
        runner.lease, runner.generation, runner.quota = 'synthetic-lease', 1, 45000
        runner.update = {'v': 1, 'global': {'pts': 10, 'qts': 0, 'seq': 1, 'date': '2024-01-01T00:00:00Z'}}
        value = copy.deepcopy(runner.update)
        value['global']['date'] = '2024-01-01T00:01:00Z'
        await runner.save_update(value)
        broker.post.assert_not_awaited()
        self.assertEqual(runner.update, value)
        self.clock.now = 301
        async def receipt(_endpoint, body):
            return {'ok': True, 'batch_id': body['batch_id'], 'quota_remaining': 44936}
        broker.post.side_effect = receipt
        await runner.save_update(value)
        self.assertEqual(broker.post.await_count, 1)

    async def test_content_progress_and_initial_baseline_are_never_deferred(self):
        async def receipt(_endpoint, body):
            return {'ok': True, 'batch_id': body['batch_id'], 'quota_remaining': 44000}
        broker = SimpleNamespace(post=AsyncMock(side_effect=receipt))
        runner = service.ServiceRunner(None, broker, 1, self.budget)
        runner.lease, runner.generation, runner.quota = 'synthetic-lease', 1, 45000
        value = {'v': 1, 'global': {'pts': 10, 'qts': 0, 'seq': 1, 'date': '2024-01-01T00:00:00Z'}}
        await runner.save_update(value)
        value['global']['pts'] = 11
        await runner.save_update(value)
        value['common_delete_pts'] = 12
        await runner.save_update(value)
        self.assertEqual(broker.post.await_count, 3)

    async def test_service_connection_is_not_closed_between_leases(self):
        client = SimpleNamespace(disconnect=AsyncMock())
        await service.ServiceTelegram(client, 1, self.budget).disconnect()
        client.disconnect.assert_not_awaited()

    async def test_revoked_lease_stops_before_another_telegram_read(self):
        broker = SimpleNamespace(post=AsyncMock(side_effect=sync.HttpFailure(409)))
        telegram = SimpleNamespace(rpc=AsyncMock())
        runner = service.ServiceRunner(telegram, broker, 1, self.budget)
        runner.lease, runner.generation = 'synthetic-lease', 1
        self.clock.now = 31
        with self.assertRaises(sync.HttpFailure):
            await runner.global_difference()
        telegram.rpc.assert_not_awaited()

    async def test_live_checks_run_during_history_discovery_only_when_due(self):
        runner = sync.Runner(None, None, 1, self.budget, live_interval=10)
        runner.global_difference = AsyncMock()
        runner.update['global'] = {'pts': 1}
        self.clock.now = 9
        await runner.live_tick()
        runner.global_difference.assert_not_awaited()
        self.clock.now = 11
        await runner.live_tick()
        self.assertEqual(runner.global_difference.await_count, 1)
        await runner.live_tick()
        self.assertEqual(runner.global_difference.await_count, 1)

    async def test_supervisor_stops_without_retrying_revoked_service_credentials(self):
        stop = asyncio.Event()
        collector = SimpleNamespace(status='starting', cycle=AsyncMock(return_value=('error', None, 401)))
        task = asyncio.create_task(service.supervise(collector, stop))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        stop.set()
        await asyncio.wait_for(task, 1)
        self.assertEqual(collector.cycle.await_count, 1)

    async def test_stop_cancels_inflight_cycle(self):
        stop, started, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def cycle():
            started.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        collector = SimpleNamespace(status='starting', cycle=cycle)
        task = asyncio.create_task(service.supervise(collector, stop))
        await started.wait()
        stop.set()
        await asyncio.wait_for(task, 1)
        self.assertTrue(cancelled.is_set())

    async def test_service_broker_signs_retries_without_changing_payload(self):
        requests = []
        async def request(_method, url, headers, body, timeout):
            requests.append((url, headers, body))
            return (500, b'') if len(requests) == 1 else (200, b'{"ok":true}')
        signer = service.ServiceSigner('1' * 64, 'fictional-collector', wall=lambda: 1735689600)
        broker = sync.Broker('https://synthetic.invalid', signer, SimpleNamespace(request=request), self.budget)
        await broker.post('finish', {'lease_id': 'synthetic', 'generation': 1, 'status': 'idle'})
        self.assertEqual(requests[0][2], requests[1][2])
        self.assertEqual(requests[0][1], requests[1][1])


class ConfigurationTests(unittest.TestCase):
    def config_env(self):
        return {'TELEGRAM_API_ID': '1', 'TELEGRAM_API_HASH': 'a' * 32,
                'TELEGRAM_USER_SESSION': 'synthetic-session', 'TELEGRAM_ACCOUNT_OWNER_ID': '1',
                'TELEGRAM_CONTEXT_BROKER_URL': 'https://synthetic.invalid',
                'TELEGRAM_ACCOUNT_SERVICE_ID': 'fictional-collector', 'TELEGRAM_ACCOUNT_SERVICE_SECRET': '1' * 64}

    def test_config_has_no_github_credentials_or_bot_token(self):
        config = service.ServiceConfig.from_env(self.config_env())
        self.assertEqual(config.owner, 1)
        self.assertNotIn('synthetic-session', repr(config))
        self.assertNotIn('a' * 32, repr(config))

    def test_mounted_credentials_supported_but_ambiguous_values_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'synthetic-key'
            path.write_text('1' * 64 + '\n', encoding='utf-8')
            env = self.config_env()
            env['TELEGRAM_ACCOUNT_SERVICE_SECRET_FILE'] = str(path)
            with self.assertRaises(sync.SafeError):
                service.ServiceConfig.from_env(env)
            del env['TELEGRAM_ACCOUNT_SERVICE_SECRET']
            self.assertEqual(service.ServiceConfig.from_env(env).secret, '1' * 64)
            path.write_text('x' * 16385, encoding='utf-8')
            with self.assertRaises(sync.SafeError):
                service.ServiceConfig.from_env(env)

    def test_no_plain_http_credentials_queries_or_redirect_origins(self):
        for origin in ('http://synthetic.invalid', 'https://user:pass@synthetic.invalid',
                       'https://synthetic.invalid?key=value', 'https://synthetic.invalid/path'):
            env = {**self.config_env(), 'TELEGRAM_CONTEXT_BROKER_URL': origin}
            with self.assertRaises(sync.SafeError):
                service.ServiceConfig.from_env(env)

    def test_signature_cross_language_canonical_format(self):
        run = '11111111-1111-4111-8111-111111111111'
        signer = service.ServiceSigner('1' * 64, 'fictional-collector', run, wall=lambda: 1735689600)
        headers = signer.headers('https://synthetic.invalid/internal/account-context/claim', b'{}')
        canonical = '\n'.join(['context-service:v1', 'POST', '/internal/account-context/claim',
                               'fictional-collector', run, '1735689600', hashlib.sha256(b'{}').hexdigest()])
        self.assertEqual(headers['Authorization'], 'Context-HMAC ' + hmac.new(bytes.fromhex('1' * 64), canonical.encode(), hashlib.sha256).hexdigest())

    def test_floodwait_and_daily_quota_are_not_bypassed_by_restarts(self):
        self.assertEqual(service.retry_delay('flood_wait', 7201), 7201)
        self.assertEqual(service.retry_delay('error', retry=7201), 7201)
        self.assertEqual(service.retry_delay('quota', now=datetime(2024, 1, 1, 23, 59, 30, tzinfo=timezone.utc)), 35)
        self.assertEqual(service.retry_delay('error', failures=100), 900)
        self.assertEqual(service.retry_delay('idle'), 1)

    def test_health_never_returns_account_data_and_detects_stalled_cycles(self):
        collector = SimpleNamespace(status='syncing', clock=lambda: 800, last_progress=0)
        handler = object.__new__(service.health_handler(collector))
        handler.path, handler.wfile = '/healthz', io.BytesIO()
        responses = []
        handler.send_response = responses.append
        handler.send_header = lambda *_args: None
        handler.end_headers = lambda: None
        handler.do_GET()
        self.assertEqual(responses, [503])
        self.assertEqual(json.loads(handler.wfile.getvalue()), {'healthy': False, 'status': 'syncing'})


if __name__ == '__main__':
    unittest.main()
