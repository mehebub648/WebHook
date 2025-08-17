<?php
// Index: Manage webhook URLs (auto-generate id/label), list in a table
// with request counts, and provide View/Delete actions.

$storageDir = __DIR__ . DIRECTORY_SEPARATOR . 'storage';
$urlsFile = $storageDir . DIRECTORY_SEPARATOR . 'urls.json';
if (!is_dir($storageDir)) { @mkdir($storageDir, 0777, true); }

function load_urls($file){
    if (!is_file($file)) return [];
    $json = @file_get_contents($file);
    if ($json === false || $json === '') return [];
    $data = json_decode($json, true);
    if (json_last_error() !== JSON_ERROR_NONE || !is_array($data)) return [];
    return $data;
}

function save_urls($file, $data){
    $json = json_encode(array_values($data), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    @file_put_contents($file, $json, LOCK_EX);
}

function generate_id(){
    $bytes = random_bytes(6);
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

function sanitize_id($id){
    $id = trim($id);
    $id = preg_replace('/[^a-zA-Z0-9_-]/', '', $id);
    if ($id === '') return null;
    return $id;
}

$urls = load_urls($urlsFile);

function next_label($existing){
    $n = count($existing) + 1;
    return 'URL ' . $n;
}

function count_requests($storageDir, $id){
    $file = $storageDir . DIRECTORY_SEPARATOR . ('requests_' . $id . '.jsonl');
    if (!is_file($file)) return 0;
    $count = 0;
    $fh = fopen($file, 'r');
    if ($fh) {
        while (!feof($fh)) {
            $line = fgets($fh);
            if ($line !== false) { $count++; }
        }
        fclose($fh);
    }
    return $count;
}

// Handle create/delete actions (POST only)
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';

    if ($action === 'create') {
        // Auto-generate id and label
        $id = generate_id();
        // Ensure unique id
        $tries = 0;
        while ($tries < 5) {
            $exists = false;
            foreach ($urls as $u) { if (($u['id'] ?? '') === $id) { $exists = true; break; } }
            if (!$exists) break;
            $id = generate_id();
            $tries++;
        }
        $label = next_label($urls);
        // Validate status (allow 100-599), default to 200
        $status = isset($_POST['status']) ? (int)$_POST['status'] : 200;
        if ($status < 100 || $status > 599) { $status = 200; }
    // Determine content type
    $ctypeOption = $_POST['content_type'] ?? 'html';
    $custom = trim($_POST['custom_content_type'] ?? '');
    switch ($ctypeOption) {
      case 'json': $ctype = 'application/json'; break;
      case 'text': $ctype = 'text/plain'; break;
      case 'xml': $ctype = 'application/xml'; break;
      case 'other': $ctype = $custom !== '' ? $custom : 'text/html'; break;
      case 'html':
      default: $ctype = 'text/html';
    }
    $entry = [ 'id' => $id, 'label' => $label, 'status' => $status, 'created_at' => date('c'), 'content_type' => $ctype ];
    // Destination URL (optional) - validate basic URL format
    $dest = trim($_POST['destination'] ?? '');
    if ($dest !== '') {
      // Ensure scheme is http or https
      $p = parse_url($dest);
      if ($p !== false && isset($p['scheme']) && in_array(strtolower($p['scheme']), ['http','https'])) {
        $entry['destination'] = $dest;
      }
    }
    $urls[] = $entry;
        save_urls($urlsFile, $urls);
        header('Location: index.php');
        exit;
    }

    if ($action === 'delete') {
        $id = sanitize_id($_POST['id'] ?? '') ?? '';
        if ($id !== '') {
            $urls = array_values(array_filter($urls, function($u) use ($id){ return ($u['id'] ?? '') !== $id; }));
            save_urls($urlsFile, $urls);
            // Remove log file if present
            $log = $storageDir . DIRECTORY_SEPARATOR . ('requests_' . $id . '.jsonl');
            if (is_file($log)) { @unlink($log); }
            header('Location: index.php');
            exit;
        }
    }
}

// Helper to build sample JSON and URL for a given id
function build_urls($id){
  // Use path-style routes: /webhook/<id> and /request/<id>
  $webhookUrl = 'webhook/' . rawurlencode($id);
  $requestsUrl = 'request/' . rawurlencode($id);
    return [$webhookUrl, $requestsUrl];
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Webhook URLs</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
  <script>
    document.addEventListener('DOMContentLoaded', function(){
      // Render full origin URLs for display only
      const origin = window.location.origin.replace(/\/$/, '');
      document.querySelectorAll('[data-href-rel]').forEach(el => {
        const rel = el.getAttribute('data-href-rel');
        el.textContent = origin + '/' + rel.replace(/^\//,'');
      });
      // Copy buttons
      document.querySelectorAll('[data-copy]').forEach(btn => {
        btn.addEventListener('click', function(){
          const target = document.getElementById(btn.getAttribute('data-copy'));
          if (target) {
            navigator.clipboard.writeText(target.textContent || '').then(()=>{
              showToast('Copied URL to clipboard');
            });
          }
        })
      });

      // Show custom content-type when 'Other' selected
      const ctype = document.getElementById('ctype');
      const custom = document.getElementById('custom_ct');
      if (ctype && custom) {
        ctype.addEventListener('change', function(){
          if (ctype.value === 'other') { custom.classList.remove('hidden'); } else { custom.classList.add('hidden'); }
        });
      }
    });
    function showToast(msg){
      const t = document.createElement('div');
      t.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-4 py-2 rounded-lg shadow-lg animate-[fadein_.2s_ease-out]';
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(()=>{ t.classList.add('opacity-0','transition','duration-300'); }, 1200);
      setTimeout(()=>{ t.remove(); }, 1600);
    }
  </script>
  <style>
    @keyframes fadein{ from{ opacity:0; transform:translate(-50%, 8px);} to{ opacity:1; transform:translate(-50%,0);} }
  </style>
  </head>
<body>
  <div class="min-h-screen bg-gray-50 text-slate-900">
    <div class="max-w-5xl mx-auto px-4 py-10">
      <div class="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <i class="fa-solid fa-link text-emerald-600"></i>
              Webhook URLs
            </h1>
            <p class="text-slate-600 mt-1">Manage endpoints and choose response status. View captured requests.</p>
          </div>
          <form method="post" action="index.php" class="flex items-center gap-3">
            <input type="hidden" name="action" value="create" />
            <label class="text-sm text-slate-600">Status</label>
            <select name="status" class="bg-white border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500">
              <?php
                $choices = [200,201,204,301,302,400,401,403,404,409,422,429,500,502,503];
                foreach ($choices as $c) { echo '<option value="'.(int)$c.'">'.$c.'</option>'; }
              ?>
            </select>
            <label class="text-sm text-slate-600">Type</label>
            <select id="ctype" name="content_type" class="bg-white border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none">
              <option value="html">HTML</option>
              <option value="json">JSON</option>
              <option value="text">Plain</option>
              <option value="xml">XML</option>
              <option value="other">Other</option>
            </select>
            <label class="text-sm text-slate-600">Forward to</label>
            <input name="destination" type="url" placeholder="https://example.com/receive" class="bg-white border border-gray-300 rounded-lg px-2 py-2 text-sm" />
            <input id="custom_ct" name="custom_content_type" type="text" placeholder="e.g. application/problem+json" class="hidden bg-white border border-gray-300 rounded-lg px-2 py-2 text-sm" />
            <button type="submit" class="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold px-4 py-2 rounded-lg shadow-sm transition">
              <i class="fa-solid fa-plus"></i>
              Add URL
            </button>
          </form>
        </div>

  <div class="mt-6 overflow-hidden rounded-xl border border-gray-200">
          <table class="w-full text-left">
            <thead class="bg-gray-50 text-slate-600 text-sm">
              <tr>
                <th class="px-4 py-3 font-semibold">URL</th>
                <th class="px-4 py-3 font-semibold w-24">Status</th>
                <th class="px-4 py-3 font-semibold w-28">Requests</th>
    <th class="px-4 py-3 font-semibold w-40">Content-Type</th>
    <th class="px-4 py-3 font-semibold w-64">Forward To</th>
                <th class="px-4 py-3 font-semibold w-64">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 bg-white">
              <?php if (empty($urls)): ?>
                <tr>
                  <td colspan="5" class="px-4 py-8 text-slate-600">No URLs yet. Create one above.</td>
                </tr>
              <?php else: ?>
                <?php foreach ($urls as $u): ?>
                  <?php $id = $u['id']; $label = $u['label'] ?? ''; $status = (int)($u['status'] ?? 200); list($webhookUrl, $requestsUrl) = build_urls($id); $count = count_requests($storageDir, $id); ?>
                  <tr class="hover:bg-gray-50 transition">
                    <td class="px-4 py-3 align-top">
                      <div class="font-mono text-sky-700 break-all flex items-center gap-2 min-w-max">
                        <i class="fa-solid fa-link"></i>
                        <!-- Clicking the displayed URL now goes to the requests (view) page -->
                        <a href="<?php echo htmlspecialchars($requestsUrl, ENT_QUOTES); ?>" class="hover:underline" title="View requests">
                          <span id="u-<?php echo htmlspecialchars($id, ENT_QUOTES); ?>" data-href-rel="<?php echo htmlspecialchars($webhookUrl, ENT_QUOTES); ?>"><?php echo htmlspecialchars($webhookUrl, ENT_QUOTES); ?></span>
                        </a>
                        <button type="button" class="ml-1 text-slate-500 hover:text-slate-700" data-copy="u-<?php echo htmlspecialchars($id, ENT_QUOTES); ?>" title="Copy full URL">
                          <i class="fa-regular fa-copy"></i>
                        </button>
                      </div>
                      <div class="text-slate-600 text-xs mt-1">ID: <code class="font-mono"><?php echo htmlspecialchars($id, ENT_QUOTES); ?></code> · Label: <?php echo htmlspecialchars($label, ENT_QUOTES); ?></div>
                    </td>
                    <td class="px-4 py-3 align-top">
                      <span class="inline-flex items-center gap-2 px-2 py-1 rounded-md border border-gray-300 bg-gray-50 text-slate-700 text-sm">
                        <i class="fa-solid fa-signal"></i>
                        <?php echo (int)$status; ?>
                      </span>
                    </td>
                    <td class="px-4 py-3 align-top font-mono text-slate-900"><?php echo (int)$count; ?></td>
                    <td class="px-4 py-3 align-top font-mono text-slate-900"><?php echo htmlspecialchars($u['content_type'] ?? 'text/html', ENT_QUOTES); ?></td>
                    <td class="px-4 py-3 align-top font-mono text-sky-700 break-all">
                      <?php if (!empty($u['destination'])): ?>
                        <a href="<?php echo htmlspecialchars($u['destination'], ENT_QUOTES); ?>" target="_blank" rel="noopener noreferrer" class="hover:underline text-xs truncate block"><?php echo htmlspecialchars($u['destination'], ENT_QUOTES); ?></a>
                      <?php else: ?>
                        <span class="text-slate-500 text-xs">—</span>
                      <?php endif; ?>
                    </td>
                    <td class="px-4 py-3 align-top">
                      <div class="flex items-center gap-2">
                        <!-- Removed the separate "View Requests" button and the requests-page copy button -->
                        <form method="post" action="index.php" onsubmit="return confirm('Delete this URL and its logs?')">
                          <input type="hidden" name="action" value="delete" />
                          <input type="hidden" name="id" value="<?php echo htmlspecialchars($id, ENT_QUOTES); ?>" />
                          <button class="inline-flex items-center gap-2 bg-rose-600 hover:bg-rose-500 text-white font-semibold px-3 py-2 rounded-lg shadow-sm transition" type="submit">
                            <i class="fa-regular fa-trash-can"></i>
                            Delete
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                <?php endforeach; ?>
              <?php endif; ?>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
