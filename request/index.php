<?php
// request/index.php - show sidebar of requests and a detail panel for a given id

// Accept id from query (compat), PATH_INFO (index.php/<id>), or /request/<id>
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
  if (!$id) {
    $requestUri = $_SERVER['REQUEST_URI'] ?? '';
    $path = parse_url($requestUri, PHP_URL_PATH) ?: '';
    $base = '/request';
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

$id = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)$id);
if ($id === '') { $id = 'default'; }

$file = __DIR__ . DIRECTORY_SEPARATOR . '..' . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . ('requests_' . $id . '.jsonl');
$items = [];
if (is_file($file)) {
    $fh = fopen($file, 'r');
    if ($fh) {
        while (($line = fgets($fh)) !== false) {
            $line = trim($line);
            if ($line === '') continue;
            $obj = json_decode($line, true);
            if (json_last_error() === JSON_ERROR_NONE && is_array($obj)) {
                $items[] = $obj;
            }
        }
        fclose($fh);
    }
}

// Newest first
usort($items, function($a, $b){
    return strcmp($b['time'] ?? '', $a['time'] ?? '');
});

// Assign/fallback request IDs for selection
foreach ($items as $i => $it) {
    if (!isset($items[$i]['rid']) || !$items[$i]['rid']) {
        $items[$i]['rid'] = 'idx-' . $i;
    }
}

$rid = isset($_GET['rid']) ? $_GET['rid'] : null;
if (!$rid && !empty($items)) { $rid = $items[0]['rid']; }

// Lookup selected item
$selected = null;
foreach ($items as $it) {
    if (($it['rid'] ?? '') === $rid) { $selected = $it; break; }
}

// URLs
$webhookUrl = '../webhook/' . rawurlencode($id);
$indexUrl = '../index.php';
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Requests for <?php echo htmlspecialchars($id, ENT_QUOTES); ?></title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
  <script>
    document.addEventListener('DOMContentLoaded', function(){
      const origin = window.location.origin.replace(/\/$/, '');
      const el = document.getElementById('fullWebhook');
      if (el && el.dataset.rel) {
        el.textContent = origin + '/' + el.dataset.rel.replace(/^\//,'');
      }
      document.getElementById('copyWebhook')?.addEventListener('click', function(){
        if (el) navigator.clipboard.writeText(el.textContent).then(()=> showToast('Copied URL'));
      });
    });
    function showToast(msg){
      const t = document.createElement('div');
      t.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-4 py-2 rounded-lg shadow-lg';
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(()=>{ t.classList.add('opacity-0','transition','duration-300'); }, 1200);
      setTimeout(()=>{ t.remove(); }, 1600);
    }
  </script>
</head>
<body>
  <div class="min-h-screen bg-gray-50 text-slate-900">
    <div class="max-w-6xl mx-auto px-4 py-8">
      <div class="grid grid-cols-1 md:grid-cols-[320px,1fr] gap-4">
        <!-- Sidebar -->
        <div class="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
          <div class="px-4 py-4 border-b border-gray-200">
            <div class="text-sm text-slate-600">Requests · <code class="font-mono text-slate-900"><?php echo htmlspecialchars($id, ENT_QUOTES); ?></code></div>
            <div class="mt-2 font-mono text-sky-700 break-all flex items-center gap-2">
              <i class="fa-solid fa-link"></i>
              <a href="<?php echo htmlspecialchars($webhookUrl, ENT_QUOTES); ?>" class="hover:underline" title="Open webhook">
                <span id="fullWebhook" data-rel="<?php echo htmlspecialchars($webhookUrl, ENT_QUOTES); ?>"><?php echo htmlspecialchars($webhookUrl, ENT_QUOTES); ?></span>
              </a>
              <button id="copyWebhook" type="button" class="text-slate-500 hover:text-slate-700" title="Copy full URL">
                <i class="fa-regular fa-copy"></i>
              </button>
            </div>
            <div class="mt-3">
              <a class="inline-flex items-center gap-2 bg-sky-600 hover:bg-sky-500 text-white font-semibold px-3 py-2 rounded-lg shadow-sm transition" href="<?php echo htmlspecialchars($indexUrl, ENT_QUOTES); ?>">
                <i class="fa-solid fa-arrow-left"></i>
                Back to Index
              </a>
            </div>
          </div>
          <div class="max-h-[70vh] overflow-auto divide-y divide-gray-100">
            <?php if (empty($items)): ?>
              <div class="px-4 py-6 text-slate-600">No requests yet.</div>
            <?php else: ?>
              <?php foreach ($items as $it): $active = (($it['rid'] ?? '') === $rid); ?>
                <a class="block px-4 py-3 hover:bg-gray-50 transition <?php echo $active ? 'bg-gray-50' : ''; ?>" href="?id=<?php echo urlencode($id); ?>&rid=<?php echo urlencode($it['rid']); ?>">
                  <div class="flex items-center gap-2 text-sm">
                    <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-gray-300 bg-gray-50 text-slate-700 font-mono text-xs"><?php echo htmlspecialchars($it['method'] ?? '', ENT_QUOTES); ?></span>
                    <span class="text-slate-500 font-mono text-xs"><?php echo htmlspecialchars($it['time'] ?? '', ENT_QUOTES); ?></span>
                    <?php if (isset($it['response_status'])): ?>
                      <span class="ml-auto inline-flex items-center gap-1 text-xs text-slate-500"><i class="fa-solid fa-signal"></i><?php echo (int)$it['response_status']; ?></span>
                    <?php endif; ?>
                  </div>
                  <div class="font-mono text-slate-600 text-xs mt-1 break-all"><?php echo htmlspecialchars(($it['path'] ?? '') ?: ($it['full_url'] ?? ''), ENT_QUOTES); ?></div>
                </a>
              <?php endforeach; ?>
            <?php endif; ?>
          </div>
        </div>

        <!-- Main -->
        <div class="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
          <?php if (!$selected): ?>
            <div class="border border-gray-200 rounded-xl p-4 bg-gray-50 text-slate-600">Select a request from the left to view details.</div>
          <?php else: ?>
            <?php
              $prettyHeaders = json_encode($selected['headers'] ?? new stdClass(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
              $prettyQuery = json_encode($selected['query'] ?? new stdClass(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
              $raw = (string)($selected['body'] ?? '');
              $prettyBody = $raw;
              $decoded = json_decode($raw, true);
              if (json_last_error() === JSON_ERROR_NONE) {
                  $prettyBody = json_encode($decoded, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
              }
              $respStatus = isset($selected['response_status']) ? (int)$selected['response_status'] : 200;
            ?>
            <h1 class="text-xl font-semibold mb-3">Request Details</h1>
            <div class="grid md:grid-cols-2 gap-3">
              <div class="border border-gray-200 rounded-xl p-3 bg-gray-50">
                <div class="grid grid-cols-[max-content,1fr] gap-x-4 gap-y-2 font-mono text-sm">
                  <div class="text-slate-500">Time</div><div><?php echo htmlspecialchars($selected['time'] ?? '', ENT_QUOTES); ?></div>
                  <div class="text-slate-500">IP</div><div><?php echo htmlspecialchars($selected['ip'] ?? '', ENT_QUOTES); ?></div>
                  <div class="text-slate-500">Method</div><div><?php echo htmlspecialchars($selected['method'] ?? '', ENT_QUOTES); ?></div>
                  <div class="text-slate-500">Response</div><div><?php echo (int)$respStatus; ?></div>
                  <div class="text-slate-500">Full URL</div><div class="break-all"><?php echo htmlspecialchars($selected['full_url'] ?? '', ENT_QUOTES); ?></div>
                  <div class="text-slate-500">User-Agent</div><div class="break-all"><?php echo htmlspecialchars($selected['user_agent'] ?? '', ENT_QUOTES); ?></div>
                </div>
              </div>
              <div class="border border-gray-200 rounded-xl p-3 bg-gray-50">
                <div class="text-slate-500 text-sm mb-1">Headers</div>
                <pre class="whitespace-pre-wrap break-all font-mono text-sm"><?php echo htmlspecialchars($prettyHeaders, ENT_QUOTES); ?></pre>
              </div>
              <div class="border border-gray-200 rounded-xl p-3 bg-gray-50 md:col-span-2">
                <div class="text-slate-500 text-sm mb-1">Query Params</div>
                <pre class="whitespace-pre-wrap break-all font-mono text-sm"><?php echo htmlspecialchars($prettyQuery, ENT_QUOTES); ?></pre>
              </div>
              <div class="border border-gray-200 rounded-xl p-3 bg-gray-50 md:col-span-2">
                <div class="text-slate-500 text-sm mb-1">Body</div>
                <pre class="whitespace-pre-wrap break-all font-mono text-sm"><?php echo htmlspecialchars($prettyBody, ENT_QUOTES); ?></pre>
              </div>
            </div>
          <?php endif; ?>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
