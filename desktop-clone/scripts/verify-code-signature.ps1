param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$Publisher)
$ErrorActionPreference='Stop'
$signature=Get-AuthenticodeSignature -LiteralPath $Path
if($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate){throw 'Release signature is missing or invalid.'}
$name=$signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)
if($name -cne $Publisher){throw 'Release publisher does not match the expected signing identity.'}
if(-not $signature.TimeStamperCertificate){throw 'Release signature must include a trusted timestamp.'}
Write-Output 'Release signature and publisher verified.'
