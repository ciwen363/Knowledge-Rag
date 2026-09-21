$ErrorActionPreference = 'Stop'

$modelDir = Join-Path $PSScriptRoot '../src/main/resources/model/bge-reranker-model'
$partsDir = Join-Path $modelDir 'parts'
$outputPath = Join-Path $modelDir 'model_quantized.onnx'
$temporaryPath = "$outputPath.partial"
$expectedHash = '912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d'
$expectedLength = 570727094
$parts = @(Get-ChildItem -LiteralPath $partsDir -Filter 'model_quantized.onnx.part*.part' -File | Sort-Object Name)

if ($parts.Count -ne 35) {
    throw "Expected 35 model parts, found $($parts.Count). Run git lfs pull first."
}
if (Test-Path -LiteralPath $outputPath) {
    $existing = Get-Item -LiteralPath $outputPath
    if ($existing.Length -eq $expectedLength -and
        (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expectedHash) {
        Write-Host 'Model already restored and verified.'
        return
    }
    throw "Model file already exists but does not match the expected checksum: $outputPath"
}
if (Test-Path -LiteralPath $temporaryPath) {
    throw "Incomplete temporary file exists: $temporaryPath"
}

$output = [System.IO.File]::Open($temporaryPath, [System.IO.FileMode]::CreateNew)
try {
    foreach ($part in $parts) {
        $inputFile = [System.IO.File]::OpenRead($part.FullName)
        try { $inputFile.CopyTo($output) } finally { $inputFile.Dispose() }
    }
} finally {
    $output.Dispose()
}

$actualLength = (Get-Item -LiteralPath $temporaryPath).Length
$actualHash = (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualLength -ne $expectedLength -or $actualHash -ne $expectedHash) {
    Remove-Item -LiteralPath $temporaryPath -Force
    throw 'Model verification failed. Check Git LFS downloads and try again.'
}
Move-Item -LiteralPath $temporaryPath -Destination $outputPath
Write-Host "Model restored and verified: $outputPath"
