<?php
// ============================================================
// scoreboard_data.php
// Returns all the data the public scoreboard needs:
//   - leaders:  the best catch per species + division
//   - recent:   every catch, newest first ("last weighed" list)
//   - updated_at: the current server time so the page can show it
// ============================================================

header('Content-Type: application/json');

// Tell browsers and proxies never to cache this response
header('Cache-Control: no-cache, no-store, must-revalidate');
header('Pragma: no-cache');
header('Expires: 0');

$data_file = __DIR__ . '/../data/catches.json';

// If no catches have been submitted yet, return empty lists
if (!file_exists($data_file)) {
    echo json_encode(['leaders' => [], 'recent' => [], 'updated_at' => date('H:i:s')]);
    exit;
}

// Read all catches from the JSON file
$content = file_get_contents($data_file);
$catches = json_decode($content, true);

if (!is_array($catches) || count($catches) === 0) {
    echo json_encode(['leaders' => [], 'recent' => [], 'updated_at' => date('H:i:s')]);
    exit;
}

// ----------------------------------------------------------
// Build the leaderboard
// Group catches by "species|division" and keep only the best.
// Best = highest weight; tie = longest length.
// ----------------------------------------------------------
$leaders = [];

foreach ($catches as $catch) {
    // The key combines species and division, e.g. "Barramundi|Senior"
    $key = $catch['species'] . '|' . $catch['division'];

    if (!isset($leaders[$key])) {
        // First catch for this group — it is automatically the leader
        $leaders[$key] = $catch;
    } else {
        $current_leader = $leaders[$key];

        $beats_by_weight = $catch['weight_kg'] > $current_leader['weight_kg'];
        $same_weight     = $catch['weight_kg'] == $current_leader['weight_kg'];
        $beats_by_length = $catch['length_cm'] > $current_leader['length_cm'];

        if ($beats_by_weight || ($same_weight && $beats_by_length)) {
            $leaders[$key] = $catch;
        }
    }
}

// Convert to a plain list and sort by species then division
$leaders_list = array_values($leaders);
usort($leaders_list, function ($a, $b) {
    if ($a['species'] !== $b['species']) {
        return strcmp($a['species'], $b['species']);
    }
    return strcmp($a['division'], $b['division']);
});

// ----------------------------------------------------------
// Build the "last weighed" list: every catch, newest first
// ----------------------------------------------------------
$recent = $catches;
usort($recent, function ($a, $b) {
    return strcmp($b['timestamp'], $a['timestamp']);
});

// Return everything as JSON
echo json_encode([
    'leaders'    => $leaders_list,
    'recent'     => $recent,
    'updated_at' => date('H:i:s'),
]);
