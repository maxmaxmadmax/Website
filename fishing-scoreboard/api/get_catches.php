<?php
// ============================================================
// get_catches.php
// Returns all catches so the edit page can list them.
// ============================================================

header('Content-Type: application/json');
header('Cache-Control: no-cache, no-store, must-revalidate');

$data_file = __DIR__ . '/../data/catches.json';

if (!file_exists($data_file)) {
    echo json_encode(['catches' => []]);
    exit;
}

$content = file_get_contents($data_file);
$catches = json_decode($content, true);

if (!is_array($catches)) {
    $catches = [];
}

// Sort newest first so the edit page shows recent entries at the top
usort($catches, function ($a, $b) {
    return strcmp($b['timestamp'], $a['timestamp']);
});

echo json_encode(['catches' => $catches]);
