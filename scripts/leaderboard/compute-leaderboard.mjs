// Recomputes the public leaderboard from live game data and republishes it
// to Supabase's `leaderboard_snapshot` table. Run on a schedule by
// .github/workflows/leaderboard.yml (see that file for the cron times) -
// the `site/` static page just reads `leaderboard_snapshot` directly with
// the anon key, so this script is the only thing that needs the far more
// powerful service role key (kept as a GitHub Actions secret, never
// committed, never sent to the browser).
//
// All the actual ranking logic (which 5 categories, how each is computed,
// the top-10 cutoff) lives in the compute_leaderboard() Postgres function
// (supabase/migrations/20260921070000_leaderboard_function.sql) - this
// script just calls it and republishes the result, so changing a ranking
// rule means a new migration, not a script edit.
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

const { data: rows, error: computeError } = await supabase.rpc("compute_leaderboard");
if (computeError) {
  console.error("compute_leaderboard() failed:", computeError);
  process.exit(1);
}

// compute_leaderboard() already returns each category's rows in rank order
// (best first) - rank is just "how many of this category have I seen so far".
const seenPerCategory = {};
const snapshotRows = (rows ?? []).map((row) => {
  seenPerCategory[row.category] = (seenPerCategory[row.category] ?? 0) + 1;
  return {
    category: row.category,
    rank: seenPerCategory[row.category],
    user_id: row.user_id,
    display_name: row.display_name,
    value: row.value,
    extra: row.extra,
  };
});

// Full recompute every run (only 3x/day, top-10-per-category scale) - clear
// the previous snapshot, then insert the fresh one. rank is always >= 1, so
// this filter matches every existing row.
const { error: deleteError } = await supabase.from("leaderboard_snapshot").delete().gte("rank", 0);
if (deleteError) {
  console.error("Failed to clear the previous snapshot:", deleteError);
  process.exit(1);
}

if (snapshotRows.length > 0) {
  const { error: insertError } = await supabase.from("leaderboard_snapshot").insert(snapshotRows);
  if (insertError) {
    console.error("Failed to write the new snapshot:", insertError);
    process.exit(1);
  }
}

console.log(
  `Leaderboard updated: ${snapshotRows.length} rows across ${Object.keys(seenPerCategory).length} categories.`,
);
