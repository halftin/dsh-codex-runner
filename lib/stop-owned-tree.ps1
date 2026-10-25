param(
  [Parameter(Mandatory=$true)][int]$RootPid,
  [Parameter(Mandatory=$true)][string]$ExpectedStart,
  [switch]$Inspect
)
$ErrorActionPreference = 'Stop'
$rootProcess = $null
try { $rootProcess = [System.Diagnostics.Process]::GetProcessById($RootPid) }
catch [System.ArgumentException] { Write-Output '{"alreadyExited":true,"pids":[]}'; exit 0 }
if ([math]::Abs(($rootProcess.StartTime.ToUniversalTime() - [datetime]::Parse($ExpectedStart).ToUniversalTime()).TotalSeconds) -gt 10) {
  throw 'Owned child creation time mismatch; no process was terminated'
}
# Open handles before enumeration/termination, so a recycled PID cannot redirect a kill.
$null = $rootProcess.Handle
if ($PSVersionTable.PSVersion.Major -ge 7 -and -not $Inspect) {
  $rootProcess.Kill($true)
  Write-Output ('{"method":"dotnet-tree","pids":[' + $RootPid + ']}')
  exit 0
}
# Windows PowerShell 5.1 has no Kill(entireProcessTree). Toolhelp avoids WMI,
# which may be unavailable to restricted accounts even for their own children.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CodexOwnedProcessSnapshot {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Entry {
    public uint size, usage, pid; public UIntPtr heap;
    public uint module, threads, parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static Entry[] Read() {
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    try {
      var rows = new List<Entry>(); var entry = new Entry(); entry.size=(uint)Marshal.SizeOf(typeof(Entry));
      if (!Process32FirstW(snapshot, ref entry)) throw new System.ComponentModel.Win32Exception();
      do { rows.Add(entry); } while(Process32NextW(snapshot, ref entry));
      return rows.ToArray();
    } finally { CloseHandle(snapshot); }
  }
}
'@
$snapshot = [CodexOwnedProcessSnapshot]::Read()
$owned = New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
$owned.Add($rootProcess)
for ($index = 0; $index -lt $owned.Count; $index++) {
  $parentProcess = $owned[$index]
  foreach ($entry in $snapshot) {
    if ($entry.parent -ne $parentProcess.Id) { continue }
    try {
      $descendant = [System.Diagnostics.Process]::GetProcessById([int]$entry.pid)
      if ($descendant.StartTime.ToUniversalTime() -lt $parentProcess.StartTime.ToUniversalTime()) { $descendant.Dispose(); continue }
      $null = $descendant.Handle
      $owned.Add($descendant)
    } catch [System.ArgumentException] { continue }
  }
}
$killErrors = @()
$ownedIds = @($owned | ForEach-Object { $_.Id })
if ($Inspect) {
  $nodes = @($owned | ForEach-Object { @{ pid=$_.Id; startedAt=$_.StartTime.ToUniversalTime().ToString('o') } })
  foreach ($item in $owned) { $item.Dispose() }
  @{ method='toolhelp-read-only'; nodes=$nodes } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}
for ($index = $owned.Count - 1; $index -ge 0; $index--) {
  try {
    if (-not $owned[$index].HasExited) { $owned[$index].Kill() }
    if (-not $owned[$index].WaitForExit(2000)) { $killErrors += 'Process exit could not be confirmed' }
  } catch { $killErrors += $_.Exception.Message }
  finally { $owned[$index].Dispose() }
}
@{ method='toolhelp-tree'; pids=$ownedIds; errors=$killErrors } | ConvertTo-Json -Compress
if ($killErrors.Count -gt 0) { exit 1 }
