import time
from datetime import datetime, timezone

import requests

from config import SUBREDDIT, DEFAULT_POST_LIMIT, SORT_MODES

HEADERS = {
    "User-Agent": "RedditAIRelationshipsScraper/1.0",
}

PULLPUSH_BASE = "https://api.pullpush.io/reddit"


def _get_json(url, params=None, retries=3):
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, params=params, timeout=30)
            if resp.status_code == 429:
                wait = 2 ** (attempt + 1)
                print(f"    Rate limited, waiting {wait}s...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            if attempt < retries - 1:
                wait = 2 ** (attempt + 1)
                print(f"    Request failed ({e}), retrying in {wait}s...")
                time.sleep(wait)
            else:
                raise
    return None


def _extract_comment(c):
    created = c.get("created_utc", 0)
    return {
        "id": c.get("id", ""),
        "body": c.get("body", ""),
        "author": c.get("author", "[deleted]"),
        "created_utc": created,
        "created_datetime": datetime.fromtimestamp(created, tz=timezone.utc).isoformat() if created else "",
        "score": c.get("score", 0),
        "parent_id": c.get("parent_id", ""),
        "is_submitter": c.get("is_submitter", False),
    }


def _extract_post(p):
    created = p.get("created_utc", 0)
    permalink = p.get("permalink", "")
    return {
        "id": p.get("id", ""),
        "title": p.get("title", ""),
        "selftext": p.get("selftext", ""),
        "author": p.get("author", "[deleted]"),
        "created_utc": created,
        "created_datetime": datetime.fromtimestamp(created, tz=timezone.utc).isoformat() if created else "",
        "score": p.get("score", 0),
        "upvote_ratio": p.get("upvote_ratio", 0),
        "num_comments": p.get("num_comments", 0),
        "url": p.get("url", ""),
        "permalink": f"https://reddit.com{permalink}" if permalink else "",
        "link_flair_text": p.get("link_flair_text"),
    }


def scrape_comments_for_post(post_id, subreddit_name=SUBREDDIT):
    """Fetch all comments for a given post via PullPush."""
    comments = []
    params = {
        "link_id": post_id,
        "subreddit": subreddit_name,
        "size": 100,
        "sort": "asc",
        "sort_type": "created_utc",
    }

    url = f"{PULLPUSH_BASE}/search/comment/"

    while True:
        data = _get_json(url, params=params)
        if not data:
            break

        batch = data.get("data", [])
        if not batch:
            break

        for c in batch:
            comments.append(_extract_comment(c))

        if len(batch) < 100:
            break

        # Paginate using the last comment's timestamp
        last_utc = batch[-1].get("created_utc", 0)
        params["after"] = last_utc
        time.sleep(0.5)

    return comments


def scrape_posts(subreddit_name=SUBREDDIT, limit=DEFAULT_POST_LIMIT, sort_modes=None):
    if sort_modes is None:
        sort_modes = SORT_MODES

    seen_ids = set()
    posts = []

    for mode in sort_modes:
        print(f"  Fetching '{mode}' posts from r/{subreddit_name} via PullPush...")

        params = {
            "subreddit": subreddit_name,
            "size": min(limit, 100),
            "sort": "desc",
            "sort_type": "created_utc",
        }

        if mode == "top":
            params["sort_type"] = "score"
        elif mode == "hot":
            params["sort_type"] = "score"

        url = f"{PULLPUSH_BASE}/search/submission/"
        count = 0
        fetched = 0

        while fetched < limit:
            data = _get_json(url, params=params)
            if not data:
                break

            batch = data.get("data", [])
            if not batch:
                break

            for p in batch:
                post_id = p.get("id", "")
                if not post_id or post_id in seen_ids:
                    continue
                seen_ids.add(post_id)

                extracted = _extract_post(p)
                print(f"    [{len(posts) + 1}] {extracted['title'][:80]}")

                extracted["comments"] = scrape_comments_for_post(post_id, subreddit_name)
                posts.append(extracted)
                count += 1

            fetched += len(batch)
            if len(batch) < 100:
                break

            # Paginate using last post's timestamp
            last_utc = batch[-1].get("created_utc", 0)
            params["before"] = last_utc
            time.sleep(1)

        print(f"  Got {count} new posts from '{mode}' (total unique: {len(posts)})")

    return posts
