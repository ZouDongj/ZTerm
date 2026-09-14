$ErrorActionPreference = 'SilentlyContinue'
$log = 'D:\Code\MyTerm\ZTerm\artifacts\console-leak-cleanup-20260914.log'
"killed process list - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File $log -Encoding utf8

function Get-Map {
  $procs = Get-CimInstance Win32_Process
  $live = @{}
  foreach ($p in $procs) { $live[[int]$p.ProcessId] = $true }
  return @{ procs = $procs; live = $live }
}

$targets = @('bash.exe','OpenConsole.exe','conhost.exe')
$totalKilled = 0

# Iterative orphan sweep: kill target-name processes whose parent no longer
# exists, then recompute. Children of killed orphans become orphans next pass,
# so this converges on whole leaked trees without touching anything whose
# ancestor chain is still alive (user's WT / herdr / ZTerm / agent hosts).
for ($pass = 1; $pass -le 8; $pass++) {
  $m = Get-Map
  $orphans = @($m.procs | Where-Object {
    ($targets -contains $_.Name) -and -not $m.live.ContainsKey([int]$_.ParentProcessId)
  })
  if ($orphans.Count -eq 0) { break }
  foreach ($p in $orphans) {
    "{0,-16} pid={1,-7} ppid={2} start={3}" -f $p.Name, $p.ProcessId, $p.ParentProcessId, $p.CreationDate.ToString('MM-dd HH:mm') | Out-File $log -Append -Encoding utf8
    Stop-Process -Id $p.ProcessId -Force
    $totalKilled++
  }
  Start-Sleep -Milliseconds 400
}

""
"=== killed total: $totalKilled (log: $log) ==="
$m = Get-Map
""
"=== remaining counts ==="
$names = @('bash.exe','zterm.exe','OpenConsole.exe','conhost.exe','herdr.exe','WindowsTerminal.exe')
$m.procs | Where-Object { $names -contains $_.Name } | Group-Object Name | Sort-Object Name | ForEach-Object { "{0,-20} x{1}" -f $_.Name, $_.Count }
""
"=== remaining bash.exe by parent (should all be live parents) ==="
$m.procs | Where-Object { $_.Name -eq 'bash.exe' } | ForEach-Object {
  $ppid = [int]$_.ParentProcessId
  $parentName = if ($m.live.ContainsKey($ppid)) { ($m.procs | Where-Object { [int]$_.ProcessId -eq $ppid } | Select-Object -First 1).Name } else { 'DEAD' }
  $parentName
} | Group-Object | Sort-Object Count -Descending | ForEach-Object { "{0,-24} x{1}" -f $_.Name, $_.Count }
