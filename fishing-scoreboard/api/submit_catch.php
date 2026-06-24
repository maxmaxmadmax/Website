<?php
// ============================================================
// submit_catch.php
// Accepts a new catch entry from the admin page and saves it.
// ============================================================

// Tell the browser we are sending back JSON
header('Content-Type: application/json');

// Only accept POST requests
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'Only POST requests are allowed.']);
    exit;
}

// Read the raw JSON body sent by the browser
$input = json_decode(file_get_contents('php://input'), true);

if (!$input) {
    echo json_encode(['success' => false, 'error' => 'Invalid request body.']);
    exit;
}

// ----------------------------------------------------------
// Allowed values for division and species
// ----------------------------------------------------------
$allowed_divisions = ['Senior', 'Junior'];

$allowed_species = [
    'Barramundi',
    'Coral Trout',
    'Spanish Mackerel',
    'Mangrove Jack',
    'Flathead',
    'Whiting',
    'Mud Crab',
    'Other Species',
];

// ----------------------------------------------------------
// Pull each field out of the request and clean it up
// ----------------------------------------------------------
$angler   = trim($input['angler']    ?? '');
$division = trim($input['division']  ?? '');
$species  = trim($input['species']   ?? '');
$weight   = floatval($input['weight_kg']  ?? 0);
$length   = floatval($input['length_cm']  ?? 0);

// ----------------------------------------------------------
// Server-side validation
// ----------------------------------------------------------
if ($angler === '') {
    echo json_encode(['success' => false, 'error' => 'Angler name is required.']);
    exit;
}

if (strlen($angler) > 100) {
    echo json_encode(['success' => false, 'error' => 'Angler name is too long (max 100 characters).']);
    exit;
}

if (!in_array($division, $allowed_divisions)) {
    echo json_encode(['success' => false, 'error' => 'Division must be Senior or Junior.']);
    exit;
}

if (!in_array($species, $allowed_species)) {
    echo json_encode(['success' => false, 'error' => 'Please select a valid species.']);
    exit;
}

if ($weight <= 0 || $weight > 500) {
    echo json_encode(['success' => false, 'error' => 'Weight must be greater than 0 and under 500 kg.']);
    exit;
}

if ($length <= 0 || $length > 400) {
    echo json_encode(['success' => false, 'error' => 'Length must be greater than 0 and under 400 cm.']);
    exit;
}

// ----------------------------------------------------------
// Build the new catch record
// ----------------------------------------------------------
$new_catch = [
    'id'        => uniqid('catch_', true),   // unique ID so we can edit/delete later
    'angler'    => htmlspecialchars($angler, ENT_QUOTES, 'UTF-8'),
    'division'  => $division,
    'species'   => $species,
    'weight_kg' => $weight,
    'length_cm' => $length,
    'timestamp' => date('Y-m-d H:i:s'),      // when it was weighed in
];

// ----------------------------------------------------------
// Read the JSON file, add the new catch, write it back.
// We use flock() (file locking) so two people submitting at
// the same time cannot corrupt the file.
// ----------------------------------------------------------
$data_file = __DIR__ . '/../data/catches.json';

// Open the file for reading and writing; create it if missing
$fp = fopen($data_file, 'c+');
if (!$fp) {
    echo json_encode(['success' => false, 'error' => 'Could not open data file. Check folder permissions.']);
    exit;
}

// Lock the file exclusively (other processes must wait)
flock($fp, LOCK_EX);

$content = stream_get_contents($fp);
$catches = json_decode($content, true);

// If the file was empty or invalid JSON, start with an empty array
if (!is_array($catches)) {
    $catches = [];
}

// Add the new catch
$catches[] = $new_catch;

// Rewrite the whole file from the start
ftruncate($fp, 0);
rewind($fp);
fwrite($fp, json_encode($catches, JSON_PRETTY_PRINT));

// Release the lock and close
flock($fp, LOCK_UN);
fclose($fp);

// Tell the browser it worked
echo json_encode(['success' => true, 'catch' => $new_catch]);
