# Read-only stand-in for a Windows machine without Node: serves the fixtures and the prototype over the same paths as mock-server.mjs.
# It keeps no state (every command answers "applied") and its event stream sends one hello and closes. Use mock-server.mjs when Node is available.
#   powershell -NoProfile -ExecutionPolicy Bypass -File ui-next/fixtures/standin-server.ps1     then open http://localhost:8732/
$root = Split-Path -Parent $PSScriptRoot
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add('http://localhost:8732/')
$l.Start()
$types = @{ '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'; '.json' = 'application/json; charset=utf-8' }
function Send($ctx, $status, $bytes, $type) { $ctx.Response.StatusCode = $status; $ctx.Response.ContentType = $type; $ctx.Response.Headers.Add('cache-control', 'no-store'); $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length); $ctx.Response.Close() }
while ($l.IsListening) {
  $ctx = $l.GetContext()
  try {
    $p = $ctx.Request.Url.AbsolutePath
    $file = $null
    if ($ctx.Request.HttpMethod -eq 'POST' -and $p -like '/api/v1/commands/*') {
      $name = $p.Substring('/api/v1/commands/'.Length)
      $body = '{"ok":true,"command":"' + $name + '","outcome":"applied","audit_id":"deadbeef","refusal_code":null,"refusal_text":null,"result":null,"undo":null,"cursor":"e-000413"}'
      Send $ctx 200 ([Text.Encoding]::UTF8.GetBytes($body)) $types['.json']; continue
    }
    if ($p -eq '/api/v1/events') {
      $body = "retry: 60000`n`nevent: hello`ndata: {`"id`":`"e-000413`",`"type`":`"hello`",`"at`":`"2026-11-12T22:04:01Z`",`"contract`":`"1.0`"}`n`n"
      Send $ctx 200 ([Text.Encoding]::UTF8.GetBytes($body)) 'text/event-stream; charset=utf-8'; continue
    }
    if ($p -eq '/api/v1/fixtures/events') { $file = "$root\fixtures\events.json" }
    elseif ($p -match '^/api/v1/schemas/([a-z-]+\.schema\.json|validate\.mjs)$') { $file = "$root\schemas\$($Matches[1])" }
    elseif ($p -match '^/api/v1/work-items/([a-z]+-\d+)$') { $file = "$root\fixtures\work-item-$($Matches[1]).json" }
    elseif ($p -match '^/api/v1/([a-z]+)$') { $file = "$root\fixtures\$($Matches[1]).json" }
    elseif ($p -eq '/') { $file = "$root\prototype\index.html" }
    elseif ($p -match '^/([A-Za-z0-9._-]+)$') { $file = "$root\prototype\$($Matches[1])" }
    if ($file -and (Test-Path $file)) { Send $ctx 200 ([IO.File]::ReadAllBytes($file)) $types[[IO.Path]::GetExtension($file)] }
    else { Send $ctx 404 ([Text.Encoding]::UTF8.GetBytes('{"error":{"code":"not_found","text":"No such resource in contract v1."}}')) $types['.json'] }
  } catch { try { $ctx.Response.Abort() } catch {} }
}
