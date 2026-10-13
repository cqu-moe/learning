import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const secureDirectoryScript = `
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('LEARNING_PRIVATE_DIRECTORY_PATH')
if ([string]::IsNullOrWhiteSpace($path)) { throw 'LEARNING_PRIVATE_DIRECTORY_PATH is empty' }
$root = [System.IO.Path]::GetFullPath($path)
if ([System.IO.Path]::GetPathRoot($root) -eq $root) { throw 'Refusing a file-system root as the private data directory' }

function Assert-ApplicationPath([string]$candidate) {
  $fullPath = [System.IO.Path]::GetFullPath($candidate)
  $rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Application path escapes the private data directory: $fullPath"
  }
  return $fullPath
}

function Get-SafeItem([string]$candidate) {
  $item = Get-Item -LiteralPath $candidate -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing reparse point in private data directory: $candidate"
  }
  return $item
}

function Clear-And-GrantAcl([string]$candidate, [bool]$isDirectory) {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity.User) { throw 'Windows current user SID is unavailable' }
  $acl = Get-Acl -LiteralPath $candidate
  $acl.SetOwner($identity.User)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($existingRule in @($acl.Access)) {
    [void]$acl.RemoveAccessRuleSpecific($existingRule)
  }
  $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  if ($isDirectory) {
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $type = [System.Security.AccessControl.AccessControlType]::Allow
  $rule = New-Object -TypeName System.Security.AccessControl.FileSystemAccessRule -ArgumentList @($identity.User, $rights, $inheritance, $propagation, $type)
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $candidate -AclObject $acl
}

$ancestor = $root
while ([System.IO.Path]::GetPathRoot($ancestor) -ne $ancestor) {
  if (Test-Path -LiteralPath $ancestor) { [void](Get-SafeItem $ancestor) }
  $ancestor = [System.IO.Path]::GetDirectoryName($ancestor)
}
[void][System.IO.Directory]::CreateDirectory($root)

$rootItem = Get-SafeItem $root
if (-not $rootItem.PSIsContainer) { throw 'Private data path is not a directory' }
Clear-And-GrantAcl $root $true

foreach ($coreName in @('master.key', 'state.db', 'state.db-wal', 'state.db-shm', 'learning.lock')) {
  $candidate = Assert-ApplicationPath ([System.IO.Path]::Combine($root, $coreName))
  if (-not (Test-Path -LiteralPath $candidate)) { continue }
  $item = Get-SafeItem $candidate
  if ($item.PSIsContainer) { throw "Private core path is a directory: $candidate" }
  Clear-And-GrantAcl $candidate $false
}

foreach ($subtree in @('artifacts', 'exports')) {
  $directory = Assert-ApplicationPath ([System.IO.Path]::Combine($root, $subtree))
  if (-not (Test-Path -LiteralPath $directory)) { continue }
  $directoryItem = Get-SafeItem $directory
  if (-not $directoryItem.PSIsContainer) { throw "Private output path is not a directory: $directory" }
  Clear-And-GrantAcl $directory $true

  $pending = [System.Collections.Generic.Stack[string]]::new()
  $pending.Push($directory)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($current)) {
      $candidate = Assert-ApplicationPath $entry
      $item = Get-SafeItem $candidate
      Clear-And-GrantAcl $candidate $item.PSIsContainer
      if ($item.PSIsContainer) { $pending.Push($candidate) }
    }
  }
}
`;

export function securePrivateDirectory(path: string): void {
  if (process.platform !== 'win32') return;

  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = join(systemRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const result = spawnSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', secureDirectoryScript],
    {
      encoding: 'utf8',
      env: { ...process.env, LEARNING_PRIVATE_DIRECTORY_PATH: path },
      maxBuffer: 16 * 1024,
      timeout: 30_000,
      windowsHide: true,
    },
  );

  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? `exit code ${result.status}`;
    const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().slice(0, 4096);
    throw new Error(`unable to secure Windows data directory (${reason})${output ? `: ${output}` : ''}`);
  }
}
