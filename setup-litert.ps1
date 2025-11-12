# Setup Script for LiteRT WASM Files
# This script copies the necessary WASM files from node_modules to public directory

Write-Host "Setting up LiteRT WASM files..." -ForegroundColor Green

# Define paths
$nodeModulesWasm = "node_modules\@litertjs\core\wasm"
$publicWasm = "public\litert-wasm"

# Check if node_modules WASM exists
if (-Not (Test-Path $nodeModulesWasm)) {
    Write-Host "Error: WASM files not found in node_modules." -ForegroundColor Red
    Write-Host "Please run 'pnpm install' first." -ForegroundColor Yellow
    exit 1
}

# Create public directory if it doesn't exist
if (-Not (Test-Path $publicWasm)) {
    Write-Host "Creating $publicWasm directory..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $publicWasm -Force | Out-Null
}

# Copy WASM files
Write-Host "Copying WASM files from $nodeModulesWasm to $publicWasm..." -ForegroundColor Yellow
Copy-Item -Path "$nodeModulesWasm\*" -Destination $publicWasm -Recurse -Force

Write-Host "✓ WASM files copied successfully!" -ForegroundColor Green

# Create captured_images directory if it doesn't exist
$capturedImages = "public\captured_images"
if (-Not (Test-Path $capturedImages)) {
    Write-Host "Creating $capturedImages directory..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $capturedImages -Force | Out-Null
    Write-Host "✓ Created captured_images directory!" -ForegroundColor Green
}

# Check if model exists
$modelPath = "public\models\yolo_trained.tflite"
if (-Not (Test-Path $modelPath)) {
    Write-Host "Warning: Model file not found at $modelPath" -ForegroundColor Yellow
    Write-Host "Please place your TFLite model in public/models/" -ForegroundColor Yellow
} else {
    $modelSize = (Get-Item $modelPath).Length / 1MB
    Write-Host "✓ Model found: $modelPath ($($modelSize.ToString('F2')) MB)" -ForegroundColor Green
}

Write-Host "`nSetup complete! You can now run the application." -ForegroundColor Green
Write-Host "Run: pnpm dev" -ForegroundColor Cyan
