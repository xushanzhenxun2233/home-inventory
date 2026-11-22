# 家物志 · 零依赖局域网手机访问与无线同步服务 (Windows PowerShell)
param(
  [int]$Port = 8088
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SyncFile = Join-Path $Root 'sync-cache.json'

$MimeTypes = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.ico'  = 'image/x-icon'
}

function Send-Response {
  param(
    [System.IO.Stream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    [string]$ContentType,
    [byte[]]$BodyBytes
  )
  if ($null -eq $BodyBytes) { $BodyBytes = [byte[]]@() }
  $header = "HTTP/1.1 $StatusCode $StatusText`r`n" +
            "Content-Type: $ContentType`r`n" +
            "Content-Length: $($BodyBytes.Length)`r`n" +
            "Cache-Control: no-cache`r`n" +
            "Connection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($BodyBytes.Length -gt 0) {
    $Stream.Write($BodyBytes, 0, $BodyBytes.Length)
  }
  $Stream.Flush()
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
$listener.Start()

Write-Host ''
Write-Host '======================================================' -ForegroundColor Green
Write-Host '  家物志 · 局域网手机访问 & 无线同步服务已启动！' -ForegroundColor Green
Write-Host '======================================================' -ForegroundColor Green
Write-Host ''
Write-Host "电脑访问地址:  http://127.0.0.1:$Port" -ForegroundColor Cyan

$ips = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
  Where-Object { $_.AddressFamily -eq 'InterNetwork' -and -not $_.IPAddressToString.StartsWith('127.') } |
  Select-Object -ExpandProperty IPAddressToString -Unique

foreach ($ip in $ips) {
  Write-Host "手机访问地址:  http://${ip}:${Port}" -ForegroundColor Yellow
}

Write-Host ''
Write-Host '使用步骤：'
Write-Host '  1. 确保手机和电脑连接在同一个 Wi-Fi 下。'
Write-Host '  2. 在电脑和手机浏览器分别打开上方对应地址。'
Write-Host '  3. 进入「迁移与设置」即可一键无线推送/拉取全部物品与位置照片。'
Write-Host '  4. 手机浏览器可选择「添加到主屏幕」，像独立 App 一样使用。'
Write-Host ''
Write-Host '按 Ctrl+C 停止服务...' -ForegroundColor DarkGray

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 15000
      $client.SendTimeout = 15000
      $stream = $client.GetStream()

      # Read HTTP headers byte-by-byte until \r\n\r\n
      $headerBuf = New-Object System.Collections.Generic.List[byte]
      $matched = 0
      while ($true) {
        $b = $stream.ReadByte()
        if ($b -eq -1) { break }
        $headerBuf.Add([byte]$b)
        if ($headerBuf.Count -ge 4) {
          $n = $headerBuf.Count
          if ($headerBuf[$n-4] -eq 13 -and $headerBuf[$n-3] -eq 10 -and $headerBuf[$n-2] -eq 13 -and $headerBuf[$n-1] -eq 10) {
            $matched = 1
            break
          }
        }
        if ($headerBuf.Count -gt 65536) { break }
      }

      if ($matched -eq 0 -or $headerBuf.Count -eq 0) {
        $client.Close()
        continue
      }

      $headerText = [System.Text.Encoding]::ASCII.GetString($headerBuf.ToArray())
      $lines = $headerText -split "`r`n"
      $reqParts = $lines[0] -split ' '
      if ($reqParts.Length -lt 2) {
        $client.Close()
        continue
      }

      $method = $reqParts[0].ToUpper()
      $rawPath = ($reqParts[1] -split '\?')[0]
      $contentLength = 0
      foreach ($line in $lines) {
        if ($line -match '^Content-Length:\s*(\d+)') {
          $contentLength = [int]$Matches[1]
        }
      }

      # Read request body if present
      $bodyBytes = [byte[]]@()
      if ($contentLength -gt 0) {
        $bodyBytes = New-Object byte[] $contentLength
        $readTotal = 0
        while ($readTotal -lt $contentLength) {
          $chunk = $stream.Read($bodyBytes, $readTotal, $contentLength - $readTotal)
          if ($chunk -le 0) { break }
          $readTotal += $chunk
        }
      }

      # API routes
      if ($rawPath -eq '/api/ping' -and $method -eq 'GET') {
        $hasSnap = Test-Path $SyncFile
        $updatedAt = if ($hasSnap) { (Get-Item $SyncFile).LastWriteTimeUtc.ToString('o') } else { $null }
        $json = @{ ok = $true; hasSnapshot = $hasSnap; updatedAt = $updatedAt } | ConvertTo-Json -Compress
        Send-Response -Stream $stream -StatusCode 200 -StatusText 'OK' -ContentType 'application/json; charset=utf-8' -BodyBytes ([System.Text.Encoding]::UTF8.GetBytes($json))
      }
      elseif ($rawPath -eq '/api/sync' -and $method -eq 'POST') {
        [System.IO.File]::WriteAllBytes($SyncFile, $bodyBytes)
        $json = @{ ok = $true; bytes = $bodyBytes.Length } | ConvertTo-Json -Compress
        Send-Response -Stream $stream -StatusCode 200 -StatusText 'OK' -ContentType 'application/json; charset=utf-8' -BodyBytes ([System.Text.Encoding]::UTF8.GetBytes($json))
      }
      elseif ($rawPath -eq '/api/sync' -and $method -eq 'GET') {
        if (Test-Path $SyncFile) {
          $data = [System.IO.File]::ReadAllBytes($SyncFile)
          Send-Response -Stream $stream -StatusCode 200 -StatusText 'OK' -ContentType 'application/json; charset=utf-8' -BodyBytes $data
        } else {
          $json = '{"error":"no_snapshot"}'
          Send-Response -Stream $stream -StatusCode 404 -StatusText 'Not Found' -ContentType 'application/json; charset=utf-8' -BodyBytes ([System.Text.Encoding]::UTF8.GetBytes($json))
        }
      }
      else {
        # Static file serving
        $rel = if ($rawPath -eq '/' -or $rawPath -eq '') { 'index.html' } else { $rawPath.TrimStart('/') }
        if ($rel -match '\.\.') {
          Send-Response -Stream $stream -StatusCode 403 -StatusText 'Forbidden' -ContentType 'text/plain; charset=utf-8' -BodyBytes ([System.Text.Encoding]::UTF8.GetBytes('Forbidden'))
        } else {
          $filePath = Join-Path $Root $rel
          if ((Test-Path $filePath) -and -not (Get-Item $filePath).PSIsContainer) {
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            $mime = if ($MimeTypes.ContainsKey($ext)) { $MimeTypes[$ext] } else { 'application/octet-stream' }
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            Send-Response -Stream $stream -StatusCode 200 -StatusText 'OK' -ContentType $mime -BodyBytes $bytes
          } else {
            Send-Response -Stream $stream -StatusCode 404 -StatusText 'Not Found' -ContentType 'text/plain; charset=utf-8' -BodyBytes ([System.Text.Encoding]::UTF8.GetBytes('Not Found'))
          }
        }
      }
    } catch {
      # Ignore transient socket disconnects
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}
