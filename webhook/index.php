<?php
// PHP-only router + handler for /webhook paths (no .htaccess)
// Supports:
// - /webhook/index.php/<id>
// - /webhook/?id=<id>
// Optional: /webhook/<id> if your server maps it here

// 1) Extract ID from query, PATH_INFO, or REQUEST_URI
$id = null;

if (isset($_GET['id']) && $_GET['id'] !== '') {
    $id = $_GET['id'];
} else {
    $pathInfo = $_SERVER['PATH_INFO'] ?? '';
    if (is_string($pathInfo) && $pathInfo !== '') {
        $pathInfo = ltrim($pathInfo, '/');
        $segments = explode('/', $pathInfo);
        $id = $segments[0] ?? null;
    }

    if ($id === null || $id === '') {
        $requestUri = $_SERVER['REQUEST_URI'] ?? '';
        $path = parse_url($requestUri, PHP_URL_PATH) ?: '';
        $base = '/webhook';
        if (strpos($path, $base) === 0) {
            $after = ltrim(substr($path, strlen($base)), '/');
            if (strpos($after, 'index.php') === 0) {
                $after = ltrim(substr($after, strlen('index.php')), '/');
            }
            if ($after !== '') {
                $segments = explode('/', $after);
                $id = $segments[0] ?? null;
            }
        }
    }
}

if (!is_string($id) || $id === '') {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Missing webhook id";
    exit;
}

// Make available to downstream code if needed
$_GET['id'] = $id;
// 2) Webhook handling logic
$rawBody = file_get_contents('php://input');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Load urls configuration to find configured response status
$storageDir = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'storage';
$urlsFile = $storageDir . DIRECTORY_SEPARATOR . 'urls.json';
// defaults
$status = 200; // default
$contentType = 'text/html';
if (is_file($urlsFile)) {
    $json = @file_get_contents($urlsFile);
    $data = json_decode($json, true);
    if (json_last_error() === JSON_ERROR_NONE && is_array($data)) {
        foreach ($data as $u) {
            if (isset($u['id']) && (string)$u['id'] === (string)$id) {
                $s = isset($u['status']) ? (int)$u['status'] : 200;
                if ($s >= 100 && $s <= 599) { $status = $s; }
                if (!empty($u['content_type'])) { $contentType = $u['content_type']; }
                $destination = !empty($u['destination']) ? $u['destination'] : null;
                break;
            }
        }
    }
}

// Build log entry
$entry = [
    'time' => date('c'),
    'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
    'method' => $method,
    'user_agent' => $_SERVER['HTTP_USER_AGENT'] ?? '',
    'headers' => [],
    'query' => $_GET ?? new stdClass(),
    'body' => $rawBody ?? '',
    'full_url' => (isset($_SERVER['REQUEST_SCHEME']) ? $_SERVER['REQUEST_SCHEME'] : (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http')) . '://' . ($_SERVER['HTTP_HOST'] ?? '') . ($_SERVER['REQUEST_URI'] ?? ''),
    'path' => $_SERVER['REQUEST_URI'] ?? '',
    'response_status' => $status,
];

// Collect headers (best-effort)
foreach ($_SERVER as $k => $v) {
    if (strpos($k, 'HTTP_') === 0) {
        $hk = str_replace('HTTP_', '', $k);
        $hk = str_replace('_', '-', $hk);
        $entry['headers'][$hk] = $v;
    }
}

// Append to log file
$logFile = $storageDir . DIRECTORY_SEPARATOR . ('requests_' . preg_replace('/[^a-zA-Z0-9_-]/', '', $id) . '.jsonl');
@mkdir(dirname($logFile), 0777, true);
$line = json_encode($entry, JSON_UNESCAPED_SLASHES) . "\n";
@file_put_contents($logFile, $line, FILE_APPEND | LOCK_EX);
// If a destination is configured, forward the request and stream response back
if (!empty($destination)) {
    // Prepare headers for proxying
    $outHeaders = [];
    foreach ($entry['headers'] as $hk => $hv) {
        // Skip hop-by-hop headers
        $lkh = strtolower($hk);
        if (in_array($lkh, ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade'])) continue;
        $outHeaders[] = $hk . ': ' . $hv;
    }

    // Build destination URL: keep path and query from incoming if destination has no path
    $destParts = parse_url($destination);
    $destBase = rtrim($destination, '/');
    $destUrl = $destination;
    // If destination seems to be just host (unlikely), append path
    // We'll append the incoming path and query if destination ends with a slash
    if (isset($_SERVER['REQUEST_URI']) && substr($destination, -1) === '/') {
        $destUrl = rtrim($destination, '/') . $_SERVER['REQUEST_URI'];
    }

    $ch = curl_init($destUrl);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
    curl_setopt($ch, CURLOPT_HEADER, false);
    curl_setopt($ch, CURLOPT_HTTPHEADER, $outHeaders);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 0);
    // Forward body
    if ($rawBody !== null && $rawBody !== '') {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
    }

    // Stream response headers to client
    $responseHeaders = [];
    curl_setopt($ch, CURLOPT_HEADERFUNCTION, function($ch, $headerLine) use (&$responseHeaders) {
        $trim = rtrim($headerLine, "\r\n");
        if ($trim === '') return strlen($headerLine);
        if (strpos($trim, ':') === false) {
            // Status line
            $responseHeaders[] = $trim;
        } else {
            $responseHeaders[] = $trim;
        }
        return strlen($headerLine);
    });

    // Stream body to output as it arrives
    // Ensure implicit flush
    if (function_exists('apache_setenv')) { @apache_setenv('no-gzip', '1'); }
    @ini_set('zlib.output_compression', '0');
    @ini_set('output_buffering', '0');
    @ini_set('implicit_flush', '1');
    while (ob_get_level() > 0) ob_end_flush();
    ob_implicit_flush(true);

    // Capture response status via CURLINFO_HTTP_CODE after completion; stream body via WRITEFUNCTION
    curl_setopt($ch, CURLOPT_WRITEFUNCTION, function($ch, $data) {
        echo $data;
        // Flush immediately
        if (ob_get_level() > 0) { @ob_flush(); }
        @flush();
        return strlen($data);
    });

    // Execute
    $ok = curl_exec($ch);
    $curlErr = curl_error($ch);
    $respCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    // If cURL failed, fallback to local response
    if ($ok === false || $respCode === 0) {
        http_response_code(502);
        header('Content-Type: text/plain; charset=utf-8');
        echo "Upstream request failed" . ($curlErr ? (": " . $curlErr) : '') . "\n";
        // update log entry with proxy failure
        $entry['proxy_error'] = $curlErr;
        $entry['response_status'] = 502;
        @file_put_contents($logFile, json_encode($entry, JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND | LOCK_EX);
        exit;
    }

    // No automatic headers were sent; attempt to send minimal content-type if missing
    if (!headers_sent()) {
        header('Content-Type: application/octet-stream');
    }

    // Update log with proxied response status
    $entry['proxied_status'] = $respCode;
    $entry['response_status'] = $respCode;
    @file_put_contents($logFile, json_encode($entry, JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND | LOCK_EX);
    exit;
}

// Default local response when no destination configured
http_response_code($status);
header('Content-Type: ' . $contentType . '; charset=utf-8');
if (stripos($contentType, 'json') !== false) {
    echo json_encode([
        'ok' => true,
        'id' => $id,
        'method' => $method,
        'response_status' => $status,
        'receivedBytes' => strlen($rawBody ?? ''),
    ]);
} elseif (stripos($contentType, 'html') !== false) {
    echo "<!doctype html><html><head><meta charset=\"utf-8\"><title>Webhook " . htmlspecialchars($id, ENT_QUOTES) . "</title></head><body>" .
         "<h1>Webhook " . htmlspecialchars($id, ENT_QUOTES) . "</h1><p>Status: " . (int)$status . "</p></body></html>";
} else {
    echo "ok=true\n" .
         "id={$id}\n" .
         "method={$method}\n" .
         "status={$status}\n" .
         "bytes=" . strlen($rawBody ?? '') . "\n";
}
