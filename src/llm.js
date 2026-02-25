// OpenAI 兼容接口封装
export async function chatComplete(env, messages) {
  const base = env.OPENAI_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'z-ai/glm4_7',
      messages,
      temperature: 0.3,
      max_tokens: 1024,
    }),
  });
  if (!res.ok) throw new Error(`LLM API error: ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

// 简单关键词匹配搜索相关文档块
export function searchChunks(chunks, query, topK = 5) {
  const keywords = query.toLowerCase().split(/\s+/);
  const scored = chunks.map((c, i) => {
    const lower = c.toLowerCase();
    const score = keywords.reduce((s, kw) => {
      return s + (lower.includes(kw) ? 1 + (lower.split(kw).length - 1) * 0.5 : 0);
    }, 0);
    return { text: c, score, index: i };
  });
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => s.text);
}

// 构建问答 prompt
export async function answerQuestion(env, chunks, question) {
  const relevant = searchChunks(chunks, question);
  if (!relevant.length) {
    return '抱歉，知识库中没有找到相关内容，请换个问法试试。';
  }
  const context = relevant.join('\n---\n');
  const messages = [
    {
      role: 'system',
      content: `你是一个客服助手。根据以下知识库内容回答用户问题。帮助现场解决问题。

知识库内容：
${context}`,
    },
    { role: 'user', content: question },
  ];
  return chatComplete(env, messages);
}
