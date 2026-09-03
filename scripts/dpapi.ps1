param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Protect", "Unprotect")]
    [string]$Mode
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

$inputB64 = [Console]::In.ReadToEnd().Trim()
if ([string]::IsNullOrWhiteSpace($inputB64)) {
    throw "Entrada DPAPI vazia."
}

$data = [Convert]::FromBase64String($inputB64)

if ($Mode -eq "Protect") {
    $result = [Security.Cryptography.ProtectedData]::Protect(
        $data,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
}
else {
    $result = [Security.Cryptography.ProtectedData]::Unprotect(
        $data,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
}

[Console]::Out.Write([Convert]::ToBase64String($result))
