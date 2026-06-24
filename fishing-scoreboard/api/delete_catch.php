<?php
// ============================================================
// delete_catch.php
// Removes a catch record by its ID.
// ============================================================

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'Only POST requests are allowed.']);
    exit;
}

$input = json_decode(file_get_contents('php://input'), true);

$id = trim($input['id'] ?? '');

if ($id === '') {
    echo json_encode(['success' => false, 'error' => 'Missing catch ID.']);
    exit;
}

$data_file = __DIR__ . '/../data/catches.json';

$fp = fopen($data_file, 'c+');
if (!$fp) {
    echo json_encode(['success' => false, 'error' => 'Could not open data file.']);
    exit;
}

flock($fp, LOCK_EX);

$content = stream_get_contents($fp);
$catches = json_decode($content, true);

if (!is_array($catches)) {
    flock($fp, LOCK_UN);
    fclose($fp);
    echo json_encode(['success' => false, 'error' => 'Data file is empty or corrupt.']);
    exit;
}

// Filter out the catch with the matching ID
$original_count = count($catches);
$catches = array_values(array_filter($catches, function ($c) use ($id) {
    return $c['id'] !== $id;
}));

if (count($catches) === $original_count) {
    flock($fp, LOCK_UN);
    fclose($fp);
    echo json_encode(['success' => false, 'error' => 'Catch not found.']);
    exit;
}

ftruncate($fp, 0);
rewind($fp);
fwrite($fp, json_encode($catches, JSON_PRETTY_PRINT));

flock($fp, LOCK_UN);
fclose($fp);

echo json_encode(['success' => true]);
