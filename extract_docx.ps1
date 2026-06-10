Add-Type -AssemblyName System.IO.Compression.FileSystem

function Extract-DocxText($docxPath) {
    $temp = Join-Path $env:TEMP ([guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    try {
        [System.IO.Compression.ZipFile]::ExtractToDirectory($docxPath, $temp)
        $xmlPath = Join-Path $temp "word\document.xml"
        $xml = [System.IO.File]::ReadAllText($xmlPath, [System.Text.Encoding]::UTF8)
        $matches = [regex]::Matches($xml, '<w:t[^>]*>([^<]*)</w:t>')
        $lines = New-Object System.Collections.Generic.List[string]
        foreach ($m in $matches) {
            $val = $m.Groups[1].Value
            if ($val.Length -gt 0) { $lines.Add($val) }
        }
        return ($lines -join "`n")
    }
    finally {
        Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$root = Split-Path $PSScriptRoot -Parent
$docxFiles = Get-ChildItem -Path $root -Filter "*.docx" -File

$termsFile = $docxFiles | Where-Object { $_.Length -lt 50000 -and $_.Name -notlike "*company*" } | Select-Object -First 1
$contractAr = $docxFiles | Where-Object { $_.Name -like "*(2).docx" } | Select-Object -First 1
$contractEn = $docxFiles | Where-Object { $_.Name -like "*(1).docx" } | Select-Object -First 1

$jobs = @(
    @{ File = $termsFile; Out = "terms_ar_new.txt" }
    @{ File = $contractAr; Out = "contract_ar_v2.txt" }
    @{ File = $contractEn; Out = "contract_en_v2.txt" }
)

foreach ($job in $jobs) {
    if (-not $job.File) {
        Write-Host "SKIP: $($job.Out) - source not found"
        continue
    }
    $text = Extract-DocxText $job.File.FullName
    $outPath = Join-Path $root $job.Out
    [System.IO.File]::WriteAllText($outPath, $text, [System.Text.UTF8Encoding]::new($false))
    Write-Host "OK: $($job.Out) from $($job.File.Name) ($($text.Length) chars)"
}
