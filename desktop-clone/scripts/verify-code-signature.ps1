param([Parameter(Mandatory=$true)][string]$Path,[string]$Publisher,[switch]$AllowUnsigned)
$ErrorActionPreference='Stop'
$signature=Get-AuthenticodeSignature -LiteralPath $Path
if($AllowUnsigned){
  if($signature.Status -ne 'NotSigned'){throw 'Expected an unsigned pre-beta file; review its unexpected signature.'}
  Write-Output 'Windows publisher signature is absent, as declared for this pre-beta.'
  exit 0
}
if(-not $Publisher){throw 'Set the expected verified Windows publisher.'}
if($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate){throw 'Release signature is missing or invalid.'}
$name=$signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)
if($name -cne $Publisher){throw 'Release publisher does not match the expected signing identity.'}
if(-not $signature.TimeStamperCertificate){throw 'Release signature must include a trusted timestamp.'}
Write-Output 'Release signature and publisher verified.'
