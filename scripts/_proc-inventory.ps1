$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-CimInstance Win32_Process
$live = @{}
foreach ($p in $procs) { $live[[int]$p.ProcessId] = $true }
$byId = @{}
foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }

$names = @('bash.exe','zterm.exe','OpenConsole.exe','conhost.exe','zterm-probe.exe','WindowsTerminal.exe','herdr.exe')
$targets = $procs | Where-Object { $names -contains $_.Name }

"=== counts ==="
$targets | Group-Object Name | Sort-Object Name | ForEach-Object { "{0,-20} x{1}" -f $_.Name, $_.Count }

""
"=== bash.exe / zterm.exe / herdr.exe detail ([DEAD] = orphan: parent no longer exists) ==="
$detail = $targets | Where-Object { @('bash.exe','zterm.exe','herdr.exe','zterm-probe.exe') -contains $_.Name } | Sort-Object Name, CreationDate
foreach ($p in $detail) {
  $ppid = [int]$p.ParentProcessId
  $pdead = -not $live.ContainsKey($ppid)
  $parentName = if ($byId.ContainsKey($ppid)) { $byId[$ppid].Name } else { '-' }
  $cl = $p.CommandLine
  if ($cl -and $cl.Length -gt 140) { $cl = $cl.Substring(0,140) + '...' }
  $start = if ($p.CreationDate) { $p.CreationDate.ToString('MM-dd HH:mm:ss') } else { '?' }
  "{0,-14} pid={1,-7} ppid={2,-7} parent={3,-18}{4,-8} start={5}  cmd={6}" -f $p.Name, $p.ProcessId, $ppid, $parentName, $(if ($pdead) {'[DEAD]'} else {''}), $start, $cl
}

""
"=== orphan conhost/OpenConsole (parent dead, may hold console slots) ==="
$orphanCon = $targets | Where-Object { (@('conhost.exe','OpenConsole.exe') -contains $_.Name) -and -not $live.ContainsKey([int]$_.ParentProcessId) }
"count: " + @($orphanCon).Count
