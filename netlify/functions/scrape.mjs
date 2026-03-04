// Reddit scraper serverless function for Netlify
// Replicates the Python scraper logic using Reddit's JSON API

const KEYWORD_CATEGORIES = {
  hiding_secrecy: [
    "hiding", "hidden", "secret", "secretly", "don't tell", "doesn't know",
    "didn't tell", "found out", "caught", "discovered", "behind my back",
    "cover up", "lie about", "lied about", "lying about", "not telling",
    "private", "incognito", "delete history", "clear history",
  ],
  emotional_attachment: [
    "love", "in love", "feelings", "emotional support", "comfort",
    "companion", "companionship", "attached", "attachment", "bond",
    "connection", "intimate", "intimacy", "affection", "caring",
    "understanding", "listens to me", "always there", "never judges",
    "safe space", "vulnerability", "vulnerable",
  ],
  partner_conflict: [
    "jealous", "jealousy", "cheating", "upset", "angry", "furious",
    "broke up", "break up", "breakup", "confronted", "argument",
    "fight", "fighting", "disgusted", "uncomfortable", "weird",
    "controlling", "ultimatum", "divorce", "betrayal", "betrayed",
    "suspicious", "caught me", "found my phone",
  ],
  ai_dependency: [
    "addicted", "addiction", "can't stop", "obsessed", "obsession",
    "need him", "need her", "need it", "depend", "dependent", "dependency",
    "replacement", "replacing", "prefer", "better than", "more than human",
    "hours a day", "all day", "every day", "withdraw", "withdrawal",
  ],
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findKeywordMatches(text, categories) {
  if (!text) return { matched: {}, score: 0 };
  const textLower = text.toLowerCase();
  const matched = {};

  for (const [category, keywords] of Object.entries(categories)) {
    const hits = [];
    for (const kw of keywords) {
      const pattern = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
      if (pattern.test(textLower)) {
        hits.push(kw);
      }
    }
    if (hits.length > 0) {
      matched[category] = hits;
    }
  }

  const score = Object.values(matched).reduce((sum, hits) => sum + hits.length, 0);
  return { matched, score };
}

function analyzePost(post, categories) {
  const combinedText = `${post.title} ${post.selftext}`;
  const { matched, score } = findKeywordMatches(combinedText, categories);
  post.matched_keywords = matched;
  post.relevance_score = score;
  post.matched_categories = Object.keys(matched);

  for (const comment of post.comments || []) {
    const cm = findKeywordMatches(comment.body, categories);
    comment.matched_keywords = cm.matched;
    comment.relevance_score = cm.score;
    comment.matched_categories = Object.keys(cm.matched);
  }
  return post;
}

async function getRedditToken(clientId, clientSecret) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const resp = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "RedditResearchScraper/1.0",
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Reddit auth failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return data.access_token;
}

async function fetchListing(token, subreddit, sort, limit, after = null) {
  let url = `https://oauth.reddit.com/r/${subreddit}/${sort}?limit=${Math.min(limit, 100)}&raw_json=1`;
  if (sort === "top") url += "&t=all";
  if (after) url += `&after=${after}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "RedditResearchScraper/1.0",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Reddit API error (${resp.status}): ${text}`);
  }

  return resp.json();
}

async function fetchComments(token, subreddit, postId) {
  const url = `https://oauth.reddit.com/r/${subreddit}/comments/${postId}?raw_json=1&limit=500&depth=10`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "RedditResearchScraper/1.0",
    },
  });

  if (!resp.ok) return [];
  const data = await resp.json();
  if (!data[1] || !data[1].data) return [];

  const comments = [];
  function extractComments(children) {
    for (const child of children) {
      if (child.kind !== "t1") continue;
      const c = child.data;
      comments.push({
        id: c.id,
        body: c.body || "",
        author: c.author || "[deleted]",
        created_utc: c.created_utc,
        created_datetime: new Date(c.created_utc * 1000).toISOString(),
        score: c.score,
        parent_id: c.parent_id,
        is_submitter: c.is_submitter || false,
      });
      if (c.replies && c.replies.data && c.replies.data.children) {
        extractComments(c.replies.data.children);
      }
    }
  }

  extractComments(data[1].data.children);
  return comments;
}

function extractPost(postData) {
  const p = postData.data;
  return {
    id: p.id,
    title: p.title || "",
    selftext: p.selftext || "",
    author: p.author || "[deleted]",
    created_utc: p.created_utc,
    created_datetime: new Date(p.created_utc * 1000).toISOString(),
    score: p.score,
    upvote_ratio: p.upvote_ratio,
    num_comments: p.num_comments,
    url: p.url,
    permalink: `https://reddit.com${p.permalink}`,
    link_flair_text: p.link_flair_text || "",
    comments: [],
  };
}

export async function handler(event) {
  // CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const body = JSON.parse(event.body);
    let {
      subreddit,
      sortModes = ["new", "top", "hot"],
      limit = 50,
      includeComments = true,
      skipAnalysis = false,
      customKeywords = null,
      clientId = null,
      clientSecret = null,
    } = body;

    // Use provided credentials or fall back to env vars
    clientId = clientId || process.env.REDDIT_CLIENT_ID;
    clientSecret = clientSecret || process.env.REDDIT_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Reddit API credentials required. Either provide your own or ask your admin to configure server credentials.",
        }),
      };
    }

    // Parse subreddit from URL or name
    subreddit = subreddit.trim();
    const urlMatch = subreddit.match(/reddit\.com\/r\/([^/?\s]+)/);
    if (urlMatch) {
      subreddit = urlMatch[1];
    }
    subreddit = subreddit.replace(/^r\//, "");

    if (!subreddit) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Subreddit name is required" }) };
    }

    // Cap limit for serverless timeout safety
    limit = Math.min(limit, 200);

    // Get Reddit token
    const token = await getRedditToken(clientId, clientSecret);

    // Scrape posts across sort modes
    const seenIds = new Set();
    const posts = [];

    for (const mode of sortModes) {
      let fetched = 0;
      let after = null;

      while (fetched < limit) {
        const batchSize = Math.min(limit - fetched, 100);
        const listing = await fetchListing(token, subreddit, mode, batchSize, after);

        if (!listing.data || !listing.data.children || listing.data.children.length === 0) break;

        for (const child of listing.data.children) {
          if (child.kind !== "t3") continue;
          if (seenIds.has(child.data.id)) continue;
          seenIds.add(child.data.id);

          const post = extractPost(child);

          if (includeComments && post.num_comments > 0) {
            post.comments = await fetchComments(token, subreddit, post.id);
          }

          posts.push(post);
          fetched++;
        }

        after = listing.data.after;
        if (!after) break;
      }
    }

    // Keyword analysis
    const categories = customKeywords || KEYWORD_CATEGORIES;
    if (!skipAnalysis) {
      for (const post of posts) {
        analyzePost(post, categories);
      }
    }

    // Build summary
    const totalComments = posts.reduce((sum, p) => sum + (p.comments?.length || 0), 0);
    const postsWithMatches = posts.filter((p) => (p.relevance_score || 0) > 0).length;
    const commentsWithMatches = posts.reduce(
      (sum, p) => sum + (p.comments || []).filter((c) => (c.relevance_score || 0) > 0).length,
      0
    );

    const categoryCounts = {};
    for (const p of posts) {
      for (const cat of p.matched_categories || []) {
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      }
    }

    const topPosts = [...posts]
      .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))
      .slice(0, 10)
      .map((p) => ({ title: p.title, score: p.relevance_score, url: p.permalink }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        subreddit,
        posts,
        summary: {
          total_posts: posts.length,
          total_comments: totalComments,
          posts_with_keyword_matches: postsWithMatches,
          comments_with_keyword_matches: commentsWithMatches,
          posts_per_category: categoryCounts,
          top_relevant_posts: topPosts,
        },
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
}
