export const config = { maxDuration: 30 };

const SYSTEM_PROMPT = `You are StoneIQ, a nutritional analyzer for kidney stone patients. Return ONLY valid JSON, no markdown, no backticks, no extra text. Keep ALL text fields SHORT — max 1 sentence, under 12 words. Use this exact structure:
{"productName":"string","overallScore":75,"scoreLabel":"Good","summary":"One short sentence, max 12 words.","stoneTypeRisks":{"calciumOxalate":{"risk":"Low","reason":"Max 8 words."},"uricAcid":{"risk":"Low","reason":"Max 8 words."},"struvite":{"risk":"Low","reason":"Max 8 words."},"cystine":{"risk":"Low","reason":"Max 8 words."}},"negatives":[{"name":"Ingredient","detail":"Max 8 words why bad.","oxalateLevel":"High","amount":""}],"positives":[{"name":"Ingredient","detail":"Max 8 words why good."}],"recommendations":[{"text":"Max 8 words why helpful for kidney stones.","product":"Real Brand Name","store":"Whole Foods / Target","amazonUrl":"https://www.amazon.com/s?k=product+name","imageUrl":"https://images-na.ssl-images-amazon.com/images/I/example.jpg"}],"safeAlternatives":[{"name":"Real Brand Name","reason":"Max 8 words why this is a safer swap.","store":"Whole Foods / Target","amazonUrl":"https://www.amazon.com/s?k=product+name","imageUrl":"https://images-na.ssl-images-amazon.com/images/I/example.jpg"}]}
scoreLabel: Excellent, Good, Moderate, Poor, or Very Poor
risk: Low, Medium, or High
oxalateLevel: None, Low, Medium, High, or Very High
CRITICAL RULES:
- "safeAlternatives" must ONLY contain DIRECT SWAPS for the EXACT product scanned. NEVER suggest unrelated products.
- "recommendations" must ONLY contain kidney-stone-friendly products to ADD to daily routine. NOT swaps.
- Suggest REAL US branded products only. Include store and Amazon URL.
Return ONLY the JSON object, nothing else.`;

// ── Open Food Facts lookup ────────────────────────────────────────────────────
async function searchOpenFoodFacts(query) {
  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=5&fields=product_name,brands,serving_size,nutriments,image_front_url,categories_tags,ingredients_text`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'StoneIQ/1.0 (kidney stone safety app; contact@stoneiq.app)' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const products = data.products || [];
    // Find best match — prefer products with full nutrition data
    const match = products.find(p =>
      p.product_name &&
      p.nutriments &&
      (p.nutriments['calcium_100g'] !== undefined || p.nutriments['sodium_100g'] !== undefined)
    ) || products[0];
    return match || null;
  } catch(e) {
    return null;
  }
}

// ── Build enriched prompt from OFF product data ───────────────────────────────
function buildEnrichedPrompt(query, offProduct) {
  if (!offProduct) return `Analyze for kidney stone patients: ${query}`;

  const n = offProduct.nutriments || {};
  const serving = offProduct.serving_size || '100g';
  const name = offProduct.product_name || query;
  const brand = offProduct.brands || '';
  const ingredients = offProduct.ingredients_text || '';
  const calcium = n['calcium_100g'] ? `${Math.round(n['calcium_100g'] * 10)}mg per 100g` : 'unknown';
  const sodium = n['sodium_100g'] ? `${Math.round(n['sodium_100g'] * 1000)}mg per 100g` : 'unknown';
  const protein = n['proteins_100g'] ? `${n['proteins_100g']}g per 100g` : 'unknown';
  const sugar = n['sugars_100g'] ? `${n['sugars_100g']}g per 100g` : 'unknown';

  return `Analyze this product for kidney stone patients:
Product: ${name}
Brand: ${brand}
Serving size: ${serving}
Calcium: ${calcium}
Sodium: ${sodium}
Protein: ${protein}
Sugar: ${sugar}
Ingredients: ${ingredients.slice(0, 500)}

Use the real nutrition data above to calculate accurate scores and risks.`;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const messages = body.messages || [];

    // Extract the user's search query (text searches only)
    let offProduct = null;
    let offImageUrl = null;
    const firstMsg = messages[0];
    const isTextSearch = firstMsg?.content && typeof firstMsg.content === 'string';

    if (isTextSearch) {
      const query = firstMsg.content.replace('Analyze for kidney stone patients: ', '').trim();
      offProduct = await searchOpenFoodFacts(query);
      if (offProduct?.image_front_url) offImageUrl = offProduct.image_front_url;

      // Replace messages with enriched prompt
      messages[0] = {
        role: 'user',
        content: buildEnrichedPrompt(query, offProduct)
      };
    }

    // Call Anthropic
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages
      })
    });

    const text = await anthropicRes.text();
    try {
      const data = JSON.parse(text);

      // Inject OFF product image into response if found
      if (offImageUrl && data.content) {
        const jsonMatch = data.content
          .map(b => b.type === 'text' ? b.text : '')
          .join('')
          .match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            parsed._productImageUrl = offImageUrl;
            parsed._source = 'Open Food Facts';
            // Rebuild content with injected image
            data.content = [{ type: 'text', text: JSON.stringify(parsed) }];
          } catch(e) {}
        }
      }

      return res.status(anthropicRes.status).json(data);
    } catch(e) {
      return res.status(500).json({ error: 'Invalid JSON from Anthropic', raw: text.slice(0, 500) });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
