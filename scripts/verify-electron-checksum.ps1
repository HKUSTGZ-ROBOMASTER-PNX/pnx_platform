param(
    [Parameter(Mandatory)][string]$Archive,
    [Parameter(Mandatory)][string]$ChecksumFile
)
$ErrorActionPreference = 'Stop'
$name = Split-Path -Leaf $Archive
# sha256sum uses a '*' prefix for binary files and a space for text files.
$pattern = '^([0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($name) + '$'
$entries = @(Get-Content -LiteralPath $ChecksumFile -Encoding utf8 | ForEach-Object {
    if ($_.Trim() -match $pattern) { $Matches[1] }
})
if ($entries.Count -ne 1) { throw "Expected exactly one Electron checksum for $name; found $($entries.Count)" }
if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $entries[0]) {
    throw 'Electron checksum mismatch'
}
