$ok = 0; $fail = 0
for ($i = 0; $i -lt 6; $i++) {
  $p = Start-Process -FilePath 'D:\Program Files\Git\bin\bash.exe' -ArgumentList '-c','exit 0' -WindowStyle Hidden -PassThru -Wait
  if ($p.ExitCode -eq 0) { $ok++ } else { $fail++ }
}
Write-Output ("console alloc test: ok={0} fail={1}" -f $ok, $fail)
