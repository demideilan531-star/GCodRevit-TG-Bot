<?php
declare(strict_types=1);

const BUTTON_GMAIL = '📬 Отчёт Gmail';
const BUTTON_GITHUB = '🧩 GitHub';
const BUTTON_VIDEO = '🎬 Видео GCodRevit';
const BUTTON_WEATHER = '🌤 Погода';
const DEFAULT_REPOSITORY = 'demideilan531-star/GCodRevit-TG-Bot';
const DEFAULT_WORKFLOW = 'hourly-gmail-telegram.yml';
const DEFAULT_REF = 'main';

function env_value(string $name, string $default = ''): string
{
    $value = getenv($name);
    return $value === false ? $default : trim($value);
}

function load_config(): array
{
    $config = [
        'telegram_bot_token' => env_value('TELEGRAM_BOT_TOKEN'),
        'telegram_admin_ids' => env_value('TELEGRAM_ADMIN_IDS', '1839693017'),
        'telegram_webhook_secret' => env_value('TELEGRAM_WEBHOOK_SECRET'),
        'github_token' => env_value('GH_PAT') ?: env_value('GITHUB_TOKEN'),
        'github_repository' => env_value('GITHUB_REPOSITORY', DEFAULT_REPOSITORY),
        'github_workflow_id' => env_value('GMAIL_WORKFLOW_ID', DEFAULT_WORKFLOW),
        'github_ref' => env_value('GITHUB_REF', DEFAULT_REF),
        'cooldown_seconds' => (int) env_value('GMAIL_BUTTON_COOLDOWN_SECONDS', '300'),
        'http_timeout' => (int) env_value('GCOD_HTTP_TIMEOUT', '15'),
        'http_connect_timeout' => (int) env_value('GCOD_HTTP_CONNECT_TIMEOUT', '5'),
        'state_file' => env_value(
            'GCOD_WEBHOOK_STATE_FILE',
            rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'gcod-gmail-webhook-state.json'
        ),
    ];

    $configPath = env_value('GCOD_TG_CONFIG_PATH', __DIR__ . '/telegram-webhook-config.php');
    if (is_file($configPath)) {
        $fileConfig = require $configPath;
        if (is_array($fileConfig)) {
            $config = array_replace($config, $fileConfig);
        }
    }

    return $config;
}

function fail(int $status, string $message): void
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    echo $message;
    exit;
}

function plain_response(string $message, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    echo $message;
    exit;
}

function assert_required_config(array $config): void
{
    foreach (['telegram_bot_token', 'telegram_admin_ids', 'github_token'] as $key) {
        if (trim((string) ($config[$key] ?? '')) === '') {
            fail(500, "Missing config value: {$key}");
        }
    }
}

function verify_telegram_secret(array $config): void
{
    $expected = (string) ($config['telegram_webhook_secret'] ?? '');
    if ($expected === '') {
        return;
    }

    $actual = $_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '';
    if (!hash_equals($expected, $actual)) {
        fail(403, 'Forbidden');
    }
}

function http_json(
    string $url,
    array $payload,
    array $headers = [],
    ?int $expectedStatus = null,
    ?array $config = null
): array
{
    $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($body === false) {
        throw new RuntimeException('Could not encode JSON payload.');
    }

    $headers[] = 'Content-Type: application/json';
    $headers[] = 'Content-Length: ' . strlen($body);
    $timeout = max(3, (int) ($config['http_timeout'] ?? 15));
    $connectTimeout = max(2, (int) ($config['http_connect_timeout'] ?? 5));

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => 'POST',
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER => true,
            CURLOPT_CONNECTTIMEOUT => $connectTimeout,
            CURLOPT_TIMEOUT => $timeout,
        ]);
        if (defined('CURLOPT_IPRESOLVE') && defined('CURL_IPRESOLVE_V4')) {
            curl_setopt($ch, CURLOPT_IPRESOLVE, CURL_IPRESOLVE_V4);
        }
        $raw = curl_exec($ch);
        if ($raw === false) {
            $error = curl_error($ch);
            curl_close($ch);
            throw new RuntimeException($error);
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        $responseBody = substr($raw, $headerSize);
        curl_close($ch);
    } else {
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => implode("\r\n", $headers),
                'content' => $body,
                'timeout' => $timeout,
                'ignore_errors' => true,
            ],
        ]);
        $responseBody = file_get_contents($url, false, $context);
        if ($responseBody === false) {
            throw new RuntimeException('HTTP request failed.');
        }
        $statusLine = $http_response_header[0] ?? 'HTTP/1.1 0';
        preg_match('/\s(\d{3})\s/', $statusLine, $matches);
        $status = (int) ($matches[1] ?? 0);
    }

    if ($expectedStatus !== null && $status !== $expectedStatus) {
        throw new RuntimeException("Unexpected HTTP {$status}: " . substr($responseBody, 0, 500));
    }

    if ($responseBody === '') {
        return ['status' => $status];
    }

    $decoded = json_decode($responseBody, true);
    if (!is_array($decoded)) {
        throw new RuntimeException('Non-JSON response: ' . substr($responseBody, 0, 500));
    }
    $decoded['_http_status'] = $status;
    return $decoded;
}

function telegram_api(array $config, string $method, array $payload): array
{
    $response = http_json(
        'https://api.telegram.org/bot' . $config['telegram_bot_token'] . '/' . $method,
        $payload,
        [],
        null,
        $config
    );

    if (($response['ok'] ?? false) !== true) {
        throw new RuntimeException((string) ($response['description'] ?? "Telegram {$method} failed"));
    }

    return $response;
}

function send_message(array $config, $chatId, string $text, bool $withKeyboard = true): void
{
    $payload = [
        'chat_id' => (string) $chatId,
        'text' => $text,
    ];

    if ($withKeyboard) {
        $payload['reply_markup'] = [
            'keyboard' => [
                [['text' => BUTTON_GMAIL], ['text' => BUTTON_GITHUB]],
                [['text' => BUTTON_VIDEO], ['text' => BUTTON_WEATHER]],
            ],
            'resize_keyboard' => true,
            'one_time_keyboard' => false,
            'is_persistent' => true,
        ];
    }

    telegram_api($config, 'sendMessage', $payload);
}

function set_bot_commands(array $config): void
{
    telegram_api($config, 'setMyCommands', [
        'commands' => [
            ['command' => 'start', 'description' => 'Показать клавиатуру'],
            ['command' => 'menu', 'description' => 'Показать меню действий'],
        ],
    ]);
}

function parse_admin_ids(string $raw): array
{
    $ids = [];
    foreach (preg_split('/[,\s;]+/', $raw) ?: [] as $part) {
        $part = trim($part);
        if ($part !== '') {
            $ids[] = (int) $part;
        }
    }
    return array_values(array_unique($ids));
}

function is_allowed(int $userId, array $config): bool
{
    return in_array($userId, parse_admin_ids((string) $config['telegram_admin_ids']), true);
}

function read_state(array $config): array
{
    $path = (string) $config['state_file'];
    if (!is_file($path)) {
        return [];
    }
    $state = json_decode((string) file_get_contents($path), true);
    return is_array($state) ? $state : [];
}

function write_state(array $config, array $state): void
{
    $path = (string) $config['state_file'];
    $dir = dirname($path);
    if (!is_dir($dir)) {
        mkdir($dir, 0700, true);
    }
    file_put_contents($path, json_encode($state, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);
}

function check_cooldown(array $config, int $userId): ?int
{
    $seconds = max(0, (int) $config['cooldown_seconds']);
    if ($seconds === 0) {
        return null;
    }

    $state = read_state($config);
    $last = (int) ($state['gmail_button'][$userId] ?? 0);
    $left = $seconds - (time() - $last);
    return $left > 0 ? $left : null;
}

function mark_cooldown(array $config, int $userId): void
{
    $state = read_state($config);
    $state['gmail_button'][$userId] = time();
    write_state($config, $state);
}

function update_poll_offset(array $config, int $offset): void
{
    $state = read_state($config);
    $state['telegram_update_offset'] = $offset;
    write_state($config, $state);
}

function dispatch_gmail_workflow(array $config, $notifyChatId): void
{
    $repository = (string) $config['github_repository'];
    $workflow = rawurlencode((string) $config['github_workflow_id']);
    $url = "https://api.github.com/repos/{$repository}/actions/workflows/{$workflow}/dispatches";

    http_json(
        $url,
        [
            'ref' => (string) $config['github_ref'],
            'inputs' => [
                'notify_chat_id' => (string) $notifyChatId,
            ],
        ],
        [
            'Accept: application/vnd.github+json',
            'Authorization: Bearer ' . $config['github_token'],
            'User-Agent: GCodRevit-TG-Bot-SpaceWeb',
            'X-GitHub-Api-Version: 2022-11-28',
        ],
        204,
        $config
    );
}

function first_admin_id(array $config): ?int
{
    $ids = parse_admin_ids((string) $config['telegram_admin_ids']);
    return $ids[0] ?? null;
}

function query_secret_is_valid(array $config): bool
{
    $expected = (string) ($config['telegram_webhook_secret'] ?? '');
    $actual = (string) ($_GET['key'] ?? '');
    return $expected !== '' && $actual !== '' && hash_equals($expected, $actual);
}

function handle_get_action(array $config): void
{
    if (isset($_GET['health'])) {
        plain_response('OK');
    }

    $action = (string) ($_GET['action'] ?? '');
    if ($action === '') {
        plain_response('GCodRevit Telegram webhook is ready.');
    }

    assert_required_config($config);
    if (!query_secret_is_valid($config)) {
        plain_response('Forbidden', 403);
    }

    if ($action === 'send-menu') {
        $adminId = first_admin_id($config);
        if ($adminId === null) {
            plain_response('No admin id configured.', 500);
        }
        send_message($config, $adminId, 'Выбери действие на клавиатуре. Сейчас полностью подключена кнопка почты.');
        plain_response('Menu sent');
    }

    if ($action === 'test-telegram') {
        $adminId = first_admin_id($config);
        if ($adminId === null) {
            plain_response('No admin id configured.', 500);
        }
        send_message($config, $adminId, 'Проверка Telegram API с хостинга прошла.');
        plain_response('Telegram test sent');
    }

    if ($action === 'set-commands') {
        set_bot_commands($config);
        plain_response('Bot commands configured');
    }

    if ($action === 'delete-webhook') {
        telegram_api($config, 'deleteWebhook', ['drop_pending_updates' => false]);
        plain_response('Telegram webhook deleted. Manual polling test mode is available.');
    }

    if ($action === 'poll-once') {
        $state = read_state($config);
        $payload = [
            'timeout' => 0,
            'allowed_updates' => ['message'],
        ];
        if (!empty($state['telegram_update_offset'])) {
            $payload['offset'] = (int) $state['telegram_update_offset'];
        }

        $response = telegram_api($config, 'getUpdates', $payload);
        $updates = $response['result'] ?? [];
        $processed = 0;
        foreach ($updates as $update) {
            if (isset($update['update_id'])) {
                update_poll_offset($config, ((int) $update['update_id']) + 1);
            }
            if (is_array($update)) {
                handle_update($config, $update);
                $processed++;
            }
        }

        plain_response("Processed updates: {$processed}");
    }

    if ($action === 'config-check') {
        $result = [
            'telegram_bot_token' => trim((string) ($config['telegram_bot_token'] ?? '')) !== '',
            'telegram_admin_ids' => (string) ($config['telegram_admin_ids'] ?? ''),
            'telegram_webhook_secret' => trim((string) ($config['telegram_webhook_secret'] ?? '')) !== '',
            'github_token' => trim((string) ($config['github_token'] ?? '')) !== '',
            'github_repository' => (string) ($config['github_repository'] ?? ''),
            'github_workflow_id' => (string) ($config['github_workflow_id'] ?? ''),
            'github_ref' => (string) ($config['github_ref'] ?? ''),
            'http_timeout' => (int) ($config['http_timeout'] ?? 15),
            'http_connect_timeout' => (int) ($config['http_connect_timeout'] ?? 5),
        ];
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        exit;
    }

    plain_response('Unknown action', 404);
}

function handle_update(array $config, array $update): void
{
    $message = $update['message'] ?? null;
    if (!is_array($message)) {
        return;
    }

    $chatId = $message['chat']['id'] ?? null;
    $userId = $message['from']['id'] ?? null;
    $text = trim((string) ($message['text'] ?? ''));
    if ($chatId === null || $userId === null) {
        return;
    }

    $userId = (int) $userId;
    if (!is_allowed($userId, $config)) {
        send_message($config, $chatId, 'У тебя нет доступа к запуску публикаций.', false);
        return;
    }

    if ($text === '/start' || $text === '/menu') {
        send_message($config, $chatId, 'Выбери действие на клавиатуре. Сейчас полностью подключена кнопка почты.');
        return;
    }

    if ($text === BUTTON_GITHUB) {
        send_message($config, $chatId, 'Кнопка GitHub добавлена. Следующий шаг — подключить анализ репозитория и шаблон поста.');
        return;
    }

    if ($text === BUTTON_VIDEO) {
        send_message($config, $chatId, 'Кнопка видео добавлена. Следующий шаг — подключить приём сырого видео и подготовку поста.');
        return;
    }

    if ($text === BUTTON_WEATHER) {
        send_message($config, $chatId, 'Кнопка погоды добавлена. Следующий шаг — подключить анализ погоды, генерацию фото и пост в канал.');
        return;
    }

    if ($text !== BUTTON_GMAIL) {
        send_message($config, $chatId, 'Выбери действие кнопкой под строкой ввода.');
        return;
    }

    $left = check_cooldown($config, $userId);
    if ($left !== null) {
        send_message($config, $chatId, "Отчёт уже запускался недавно. Повтори через {$left} сек.");
        return;
    }

    dispatch_gmail_workflow($config, $chatId);
    mark_cooldown($config, $userId);
    send_message($config, $chatId, 'Отправлен запрос на отчёт.');
}

$config = load_config();

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
    try {
        handle_get_action($config);
    } catch (Throwable $error) {
        plain_response('GET action error: ' . $error->getMessage(), 500);
    }
}

assert_required_config($config);
verify_telegram_secret($config);

$rawInput = file_get_contents('php://input');
$update = json_decode((string) $rawInput, true);
if (!is_array($update)) {
    fail(400, 'Bad JSON');
}

try {
    handle_update($config, $update);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'OK';
} catch (Throwable $error) {
    $chatId = $update['message']['chat']['id'] ?? null;
    if ($chatId !== null) {
        try {
            send_message($config, $chatId, 'Не удалось запустить отчёт: ' . $error->getMessage());
        } catch (Throwable $ignored) {
        }
    }
    fail(500, 'Webhook error: ' . $error->getMessage());
}
