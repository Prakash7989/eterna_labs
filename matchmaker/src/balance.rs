use crate::models::PlayerId;

/// Candidate slice used during matching (id + skill).
#[derive(Debug, Clone, Copy)]
pub struct SkillPlayer {
    pub id: PlayerId,
    pub mmr: i32,
}

/// Split `players` (must be exactly 10 for 5v5) into two teams minimizing |avg_a - avg_b|.
/// Brute force C(n, n/2) — 252 combos for n=10, negligible vs. pool scan cost.
pub fn optimal_team_split(players: &[SkillPlayer], team_size: usize) -> Option<(Vec<PlayerId>, Vec<PlayerId>)> {
    let n = players.len();
    if n != team_size * 2 {
        return None;
    }

    let mut best: Option<(Vec<PlayerId>, Vec<PlayerId>, i64)> = None;
    let mut combo = vec![0usize; team_size];
    fill_first_combo(&mut combo, team_size);

    loop {
        let (team_a, sum_a) = team_from_combo(players, &combo);
        let team_b: Vec<PlayerId> = players
            .iter()
            .enumerate()
            .filter(|(i, _)| !combo.contains(i))
            .map(|(_, p)| p.id)
            .collect();
        let sum_b: i64 = players
            .iter()
            .enumerate()
            .filter(|(i, _)| !combo.contains(i))
            .map(|(_, p)| p.mmr as i64)
            .sum();

        let diff = (sum_a * team_size as i64 - sum_b * team_size as i64).abs();

        if best.as_ref().map_or(true, |(_, _, d)| diff < *d) {
            best = Some((team_a, team_b, diff));
        }

        if !next_combination(&mut combo, n) {
            break;
        }
    }

    best.map(|(a, b, _)| (a, b))
}

fn team_from_combo(players: &[SkillPlayer], combo: &[usize]) -> (Vec<PlayerId>, i64) {
    let mut ids = Vec::with_capacity(combo.len());
    let mut sum = 0i64;
    for &idx in combo {
        ids.push(players[idx].id);
        sum += players[idx].mmr as i64;
    }
    (ids, sum)
}

fn fill_first_combo(combo: &mut [usize], k: usize) {
    for (i, slot) in combo.iter_mut().enumerate() {
        *slot = i;
    }
    let _ = k;
}

fn next_combination(combo: &mut [usize], n: usize) -> bool {
    let k = combo.len();
    let mut i = k;
    while i > 0 {
        i -= 1;
        if combo[i] < n - k + i {
            combo[i] += 1;
            for j in i + 1..k {
                combo[j] = combo[j - 1] + 1;
            }
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn p(mmr: i32) -> SkillPlayer {
        SkillPlayer {
            id: Uuid::new_v4(),
            mmr,
        }
    }

    #[test]
    fn balances_extremes() {
        let players: Vec<_> = (0..10).map(|i| p(1000 + i * 100)).collect();
        let (a, b) = optimal_team_split(&players, 5).unwrap();
        assert_eq!(a.len(), 5);
        assert_eq!(b.len(), 5);
        let avg = |ids: &[PlayerId]| {
            let s: i32 = ids
                .iter()
                .map(|id| players.iter().find(|p| p.id == *id).unwrap().mmr)
                .sum();
            s as f64 / 5.0
        };
        assert!((avg(&a) - avg(&b)).abs() < 150.0);
    }
}
