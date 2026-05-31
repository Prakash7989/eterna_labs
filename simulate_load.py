#!/usr/bin/env python3
"""
High-Performance Load Simulation Script for 5v5 Competitive Matchmaker.
Injects thousands of concurrent player requests into the matchmaking engine,
polls their queue status, fetches match details, and reports performance and match-quality metrics.
"""

import asyncio
import argparse
import random
import sys
import time
import uuid
from statistics import mean, median
import aiohttp

# ANSI Color Codes for beautiful CLI output
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
CYAN = "\033[96m"
MAGENTA = "\033[95m"
BOLD = "\033[1m"
RESET = "\033[0m"

# Default config
DEFAULT_PLAYERS = 2000
DEFAULT_CONCURRENCY = 100
DEFAULT_URL = "http://localhost:8081"
DEFAULT_TIMEOUT = 30.0
DEFAULT_POLL_INTERVAL = 1.0
DEFAULT_REGIONS = ["na-east", "eu-west", "ap-southeast"]

class SimulationStats:
    def __init__(self):
        self.total_players = 0
        self.joined = 0
        self.matched = 0
        self.timeouts = 0
        self.errors = 0
        self.queue_times = []
        self.matches_formed = {}  # match_id -> match_details
        self.lock = asyncio.Lock()

    async def add_joined(self):
        async with self.lock:
            self.joined += 1

    async def add_matched(self, wait_time):
        async with self.lock:
            self.matched += 1
            self.queue_times.append(wait_time)

    async def add_timeout(self):
        async with self.lock:
            self.timeouts += 1

    async def add_error(self):
        async with self.lock:
            self.errors += 1

    async def record_match(self, match_id, match_data):
        async with self.lock:
            if match_id not in self.matches_formed:
                self.matches_formed[match_id] = match_data


async def simulate_player(session, player_id, mmr, region, base_url, stats, sem, timeout, poll_interval):
    """
    Simulates a single player joining the queue and polling until matched or timeout.
    """
    join_url = f"{base_url}/queue/join"
    status_url = f"{base_url}/queue/{player_id}"
    
    # 1. Join the Queue
    async with sem:
        try:
            payload = {
                "player_id": player_id,
                "mmr": mmr,
                "region": region
            }
            async with session.post(join_url, json=payload) as response:
                if response.status != 200:
                    await stats.add_error()
                    return
                await stats.add_joined()
        except Exception:
            await stats.add_error()
            return

    # 2. Poll status until matched, timeout, or error
    start_time = time.time()
    while True:
        elapsed = time.time() - start_time
        if elapsed > timeout:
            await stats.add_timeout()
            # Clean up: attempt to leave the queue on timeout
            try:
                async with session.delete(status_url) as resp:
                    pass
            except Exception:
                pass
            return

        await asyncio.sleep(poll_interval)

        try:
            async with session.get(status_url) as response:
                if response.status != 200:
                    await stats.add_error()
                    return
                data = await response.json()
                state = data.get("state")
                
                if state == "matched":
                    match_id = data.get("match_id")
                    wait_time = data.get("wait_seconds", elapsed)
                    await stats.add_matched(wait_time)
                    
                    # Fetch match details to analyze match quality
                    if match_id:
                        match_url = f"{base_url}/matches/{match_id}"
                        try:
                            async with session.get(match_url) as match_resp:
                                if match_resp.status == 200:
                                    match_data = await match_resp.json()
                                    await stats.record_match(match_id, match_data)
                        except Exception:
                            pass # Ignored, non-critical
                    return
                elif state == "left":
                    await stats.add_timeout()
                    return
        except Exception:
            await stats.add_error()
            return


async def progress_reporter(stats, expected_players, start_time):
    """
    Periodically prints simulation progress to terminal.
    """
    while True:
        await asyncio.sleep(0.5)
        async with stats.lock:
            joined = stats.joined
            matched = stats.matched
            timeouts = stats.timeouts
            errors = stats.errors
            total_matches = len(stats.matches_formed)
            
        elapsed = time.time() - start_time
        completed = matched + timeouts + errors
        
        # Draw a beautiful CLI progress bar
        bar_length = 30
        filled_length = int(round(bar_length * completed / expected_players))
        bar = '=' * filled_length + '-' * (bar_length - filled_length)
        
        sys.stdout.write(
            f"\r{BOLD}{CYAN}Progress: [{bar}] {completed}/{expected_players} ({completed/expected_players*100:.1f}%) "
            f"| Joined: {joined} | Matched: {matched} ({total_matches} games) | Timeouts: {timeouts} | Errors: {errors} | Time: {elapsed:.1f}s{RESET}"
        )
        sys.stdout.flush()
        
        if completed >= expected_players:
            break


async def main_async(args):
    print(f"\n{BOLD}{GREEN}=== Eterna Labs Matchmaker Load Simulator ==={RESET}")
    print(f"Target Server: {args.url}")
    print(f"Config: {args.players} players | Max Concurrency: {args.concurrency}")
    print(f"Regions: {', '.join(args.regions)}")
    print(f"Timeout limit: {args.timeout}s | Poll interval: {args.poll_interval}s\n")

    # Verify server health first
    async with aiohttp.ClientSession() as session:
        try:
            async with session.get(f"{args.url}/health") as resp:
                if resp.status == 200:
                    health_data = await resp.json()
                    print(f"{GREEN}[OK] Connected successfully to Matchmaker.{RESET}")
                    print(f"  Server status: {health_data.get('status')}")
                    print(f"  Players currently in queue: {health_data.get('metrics', {}).get('players_in_queue', 0)}")
                    print(f"  Matches formed so far: {health_data.get('metrics', {}).get('matches_formed', 0)}\n")
                else:
                    print(f"{YELLOW}[!] Connected to server but got status {resp.status}. Proceeding...{RESET}\n")
        except Exception as e:
            print(f"{RED}[ERROR] Cannot connect to Matchmaker at {args.url}. Is the service running?{RESET}")
            print(f"Error: {e}")
            sys.exit(1)

    stats = SimulationStats()
    stats.total_players = args.players
    sem = asyncio.Semaphore(args.concurrency)

    # Generate players with normal distribution around 1500 MMR
    players = []
    for i in range(args.players):
        player_id = str(uuid.uuid4())
        mmr = int(random.gauss(1500, 300))
        mmr = max(0, min(10000, mmr)) # Clamp to allowed range
        region = random.choice(args.regions)
        players.append((player_id, mmr, region))

    start_time = time.time()
    
    # Create the HTTP session
    async with aiohttp.ClientSession() as session:
        # Start progress reporter
        reporter_task = asyncio.create_task(progress_reporter(stats, args.players, start_time))
        
        # Inject players incrementally (to avoid crushing network limits instantly)
        tasks = []
        for player_id, mmr, region in players:
            task = asyncio.create_task(
                simulate_player(
                    session, player_id, mmr, region, args.url, stats, sem, args.timeout, args.poll_interval
                )
            )
            tasks.append(task)
            # Subtle delay between joins to simulate gradual arriving flow
            await asyncio.sleep(0.002)

        # Wait for all player simulations to complete
        await asyncio.gather(*tasks)
        await reporter_task

    total_time = time.time() - start_time
    print("\n\n" + f"{BOLD}{GREEN}=== Simulation Completed in {total_time:.2f}s ==={RESET}\n")
    
    # Report Metrics
    matched_count = stats.matched
    timeout_count = stats.timeouts
    error_count = stats.errors
    success_rate = (matched_count / args.players) * 100 if args.players > 0 else 0
    games_formed = len(stats.matches_formed)
    
    print(f"{BOLD}Queue Throughput & Success Rate:{RESET}")
    print(f"  - Total Players Simulated: {args.players}")
    print(f"  - Successfully Matched:   {GREEN}{matched_count} ({success_rate:.2f}%){RESET}")
    print(f"  - Timed Out (No Match):   {YELLOW}{timeout_count} ({timeout_count/args.players*100:.2f}%){RESET}")
    print(f"  - Server/Network Errors:  {RED}{error_count} ({error_count/args.players*100:.2f}%){RESET}")
    print(f"  - Total 5v5 Games Formed: {CYAN}{games_formed}{RESET}")
    print(f"  - Matching Throughput:     {BOLD}{matched_count / total_time:.2f} players/sec{RESET} ({games_formed / total_time:.2f} games/sec)")

    if stats.queue_times:
        print(f"\n{BOLD}Queue Wait Times (for matched players):{RESET}")
        print(f"  - Average (Mean):         {mean(stats.queue_times):.2f} seconds")
        print(f"  - Median:                 {median(stats.queue_times):.2f} seconds")
        print(f"  - Minimum:                {min(stats.queue_times):.2f} seconds")
        print(f"  - Maximum:                {max(stats.queue_times):.2f} seconds")

    if stats.matches_formed:
        mmr_spreads = []
        mmr_balances = []
        for m in stats.matches_formed.values():
            mmr_spreads.append(m.get("mmr_spread", 0))
            team_a_avg = m.get("team_a_mmr", 0)
            team_b_avg = m.get("team_b_mmr", 0)
            mmr_balances.append(abs(team_a_avg - team_b_avg))
            
        print(f"\n{BOLD}Match Quality Metrics ({games_formed} matches analyzed):{RESET}")
        print(f"  - Avg. MMR Spread within Match:     {CYAN}{mean(mmr_spreads):.1f} MMR{RESET} (ideal is lower)")
        print(f"  - Max. MMR Spread within Match:     {max(mmr_spreads):.1f} MMR")
        print(f"  - Avg. Team Skill Balance Gap:     {GREEN}{mean(mmr_balances):.1f} MMR{RESET} (ideal is close to 0)")
        print(f"  - Max. Team Skill Balance Gap:     {max(mmr_balances):.1f} MMR")
        
    print(f"\n{BOLD}{GREEN}==========================================={RESET}\n")


def main():
    parser = argparse.ArgumentParser(description="Inject concurrent players into matchmaker engine.")
    parser.add_argument("--players", type=int, default=DEFAULT_PLAYERS, help=f"Number of players (default: {DEFAULT_PLAYERS})")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY, help=f"Max concurrent requests (default: {DEFAULT_CONCURRENCY})")
    parser.add_argument("--url", type=str, default=DEFAULT_URL, help=f"Base URL of matchmaker (default: {DEFAULT_URL})")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help=f"Max time player waits in queue before timeout (default: {DEFAULT_TIMEOUT}s)")
    parser.add_argument("--poll-interval", type=float, default=DEFAULT_POLL_INTERVAL, help=f"Queue status polling interval (default: {DEFAULT_POLL_INTERVAL}s)")
    parser.add_argument("--regions", nargs="+", default=DEFAULT_REGIONS, help=f"List of regions (default: {' '.join(DEFAULT_REGIONS)})")
    
    args = parser.parse_args()
    
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print(f"\n{RED}Simulation interrupted by user.{RESET}")


if __name__ == "__main__":
    main()
