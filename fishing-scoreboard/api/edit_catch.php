<?php
// ============================================================
// edit_catch.php
// Updates an existing catch record by its ID.
// ============================================================

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'Only POST requests are allowed.']);
    exit;
}

$input = json_decode(file_get_contents('php://input'), true);

if (!$input) {
    echo json_encode(['success' => false, 'error' => 'Invalid request body.']);
    exit;
}

// ----------------------------------------------------------
// Allowed values (same as submit)
// ----------------------------------------------------------
$allowed_divisions = ['Senior', 'Junior'];

$allowed_species = [
    'Barramundi', 'Coral Trout', 'Spanish Mackerel', 'Mangrove Jack',
    'Flathead', 'Whiting', 'Mud Crab', 'Other Species',
];

// ----------------------------------------------------------
// Read and validate fields
// ----------------------------------------------------------
$id       = trim($input['id']       ?? '');
$angler   = trim($input['angler']   ?? '');
$division = trim($input['division'] ?? '');
$species  = trim($input['species']  ?? '');
$weight   = floatval($input['weight_kg'] ?? 0);
$length   = floatval($input['length_cm'] ?? 0);

if ($id === '') {
    echo json_encode(['success' => false, 'error' => 'Missing catch ID.']);
    exit;
}

if ($angler === '') {
    echo json_encode(['success' => false, 'error' => 'Angler name is required.']);
    exit;
}

if (!in_array($division, $allowed_divisions)) {
    echo json_encode(['success' => false, 'error' => 'Invalid division.']);
    exit;
}

if (!in_array($species, $allowed_species)) {
    echo json_encode(['success' => false, 'error' => 'Invalid species.']);
    exit;
}

if ($weight <= 0 || $weight > 500) {
    echo json_encode(['success' => false, 'error' => 'Invalid weight.']);
    exit;
}

if ($length <= 0 || $length > 400) {
    echo json_encode(['success' => false, 'error' => 'Invalid length.']);
    exit;
}

// ----------------------------------------------------------
// Find the catch by ID and update it
// ----------------------------------------------------------
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

$found = false;
foreach ($catches as &$catch) {
    if ($catch['id'] === $id) {
        // Update the fields but keep the original ID and timestamp
        $catch['angler']    = htmlspecialchars($angler, ENT_QUOTES, 'UTF-8');
        $catch['division']  = $division;
        $catch['species']   = $species;
        $catch['weight_kg'] = $weight;
        $catch['length_cm'] = $length;
        $found = true;
        break;
    }
}
unset($catch); // always clean up after using a reference in a loop

if (!$found) {
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
