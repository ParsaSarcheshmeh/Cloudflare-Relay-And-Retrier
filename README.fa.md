# رله و تلاش‌مجدد Cloudflare Workers برای APIهای هوش مصنوعی

[English](README.md) · **فارسی**

<div dir="rtl">

یک **Cloudflare Worker تک‌فایلی** (`worker.js`) که درخواست‌های API هوش مصنوعی را به هر سرویس‌دهنده‌ای که داخل پرامپت نامش را ببرید رله می‌کند — OpenAI، Anthropic، گیت‌وی‌های سازگار با OpenAI، Gemini، Azure و اَندپوینت‌های تصویر/ویدیو/صدا — با تلاش مجددِ بی‌امان و استریم کاملاً شفاف.

فقط کافی است `worker.js` را در ادیتور داشبورد Cloudflare پیست کنید و دیپلوی بزنید. نه پکیج npm می‌خواهد، نه مرحلهٔ بیلد، نه ماژول‌های داخلی Node.

</div>

```
client ──► Worker (parse directives → strip them → rewrite model/auth/URL)
             │
             ├─ SSRF-validated fetch with exponential backoff + Retry-After
             │
             └─◄── provider response streamed straight back (SSE/binary/JSON)
```

<div dir="rtl">

## 🚀 شروع سریع

**۱ — دیپلوی (۲ دقیقه).** داشبورد Cloudflare ← **Workers & Pages** ← **Create Worker** ← **Edit code** ← اسکافولد پیش‌فرض را کامل پاک کنید، تمام محتوای `worker.js` را پیست کنید ← **Deploy**. رلهٔ شما روی `https://<worker-name>.<account>.workers.dev` بالا می‌آید. برای اطمینان `GET /__relay/health` را صدا بزنید — باید `{"ok":true,…}` برگرداند.

*(با ترمینال راحت‌ترید؟ در همین پوشه `npm i -g wrangler && wrangler deploy` بزنید — فایل `wrangler.toml` همراه پروژه است.)*

**۲ — استفاده.** با ورکر دقیقاً مثل خودِ اَندپوینت سرویس‌دهنده رفتار کنید و دایرکتیوها را داخل متن پرامپت بگذارید:

</div>

```text
Explain this image in detail.

[provider=https://api.example.com/v1]
[model=gpt-5]
[key=sk-example]
```

<div dir="rtl">

تمامِ ایده همین است: رله دایرکتیوها را پیدا می‌کند، از متنی که مدل می‌بیند حذفشان می‌کند، مقدار `model` را در JSON خروجی قفل می‌کند، سبک هدر احراز هویت را با سرویس‌دهنده هماهنگ می‌کند و جواب را مستقیم استریم برمی‌گرداند. بقیهٔ چیزها — تصاویر، فایل‌ها، تعریف ابزارها — دست‌نخورده و بایت‌به‌بایت رد می‌شوند.

**۳ — یا همه‌چیز را لوکال نگه دارید.** هر سرور سازگار با OpenAI (مثل Ollama یا LM Studio) هم کار می‌کند:

</div>

```bash
node dev-server.mjs   # http://localhost:8787  (فقط Node، چیزی برای نصب نیست)
```

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"سلام! [provider=http://127.0.0.1:11434/v1] [model=llama3.1]"}]}'
```

<div dir="rtl">

### مدل ذهنی ۳۰ ثانیه‌ای

- دایرکتیوها شکل `[name=value]` دارند و می‌توانند هر جای پرامپت بنشینند. **اولین مورد برنده است**؛ تکرارهای بعدی نادیده گرفته می‌شوند ولی از متن پاک می‌شوند. `[bracket]`های ناشناخته، لینک‌های مارک‌داون، JSON و کدِ داخل پرامپت دست‌نخورده باقی می‌مانند.
- یونیکد هرگز نرمال‌سازی نمی‌شود — فارسی، عربی، CJK، ایموجی و متن راست‌به‌چپ سالم و بایت‌به‌بایت از سفر برمی‌گردند (`سلام دنیا 😄 [model=gpt-test]` کار می‌کند).
- تلاش مجدد خودکار است: کدهای `408 425 429 500 502 503 504 507 509 520-527 529 530` و خطاهای شبکه با backoff نمایی دوباره امتحان می‌شوند؛ خطاهای قطعی مثل `401` بدون هیچ تغییری به خودتان برمی‌گردند.
- استریم هرگز بافر نمی‌شود و به‌محض شروع جواب به سمت شما، دیگر هیچ تلاش مجددی در کار نیست.
- `[key=…]` هرگز به متنِ دیده‌شده توسط مدل، پاسخ‌های خطا یا لاگ‌ها نمی‌رسد. برای سرویس‌دهنده‌های رایگان اصلاً ننویسیدش — هیچ هدر احراز هویتی فرستاده نمی‌شود.

یک درخواست کامل دقیقاً شبیه یک فراخوانی معمولی OpenAI است:

</div>

```bash
curl https://myworker.example.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{
      "role": "user",
      "content": "سلام! Explain quantum computing [provider=https://api.provider.com/v1] [model=gpt-5] [key=sk-xxx]"
    }]
  }'
```

<div dir="rtl">

در بالادست این دریافت می‌شود: `messages[0].content = "سلام! Explain quantum computing"`، مدل `gpt-5` و هدر `Authorization: Bearer sk-xxx`.

---

# ⚙️ پیشرفته

همه‌چیزِ پایین اختیاری است — پیش‌فرض‌ها معقول‌اند و «شروع سریع» بالاتر، کل راه‌اندازی بود. هر وقت کنترل بیشتری خواستید ادامه دهید.

## مرجع دایرکتیوها

| دایرکتیو | نام‌های مستعار | اثر |
|---|---|---|
| `[provider=URL]` | `endpoint`، `base_url`، `baseurl`، `base-url` | آدرس پایهٔ سرویس‌دهندهٔ مقصد (به‌صورت پیش‌فرض فقط https) |
| `[model=NAME]` | — | مقدار `model` خروجی را اجباری می‌کند (JSON، multipart، urlencoded) |
| `[compatibility=MODE]` | `compat` و غلط‌های تایپی `compatiblity`/`compatability` | سبک احراز هویت + پیش‌فرض‌های اَندپوینت. حالت‌ها: `openai` (`chat`، `completions`، …)، `responses`، `anthropic` (`claude`، `messages`)، `images`، `videos`، `tts`، `stt` (`whisper`، `asr`)، `embeddings`، `rerank`، `gemini`، `azure`، `generic` |
| `[key=APIKEY]` | `apikey`، `api_key`، `api-key` | توکن Bearer (یا `x-api-key` برای Anthropic، `x-goog-api-key` برای Gemini و `api-key` برای Azure). برای سرویس‌دهنده‌های رایگان ننویسیدش — اصلاً هدر احراز هویت فرستاده نمی‌شود |
| `[stream=true]` | — | مقدار `stream` را در بدنهٔ JSON قفل می‌کند |
| `[timeout=60000]` | `timeout_ms` | تایم‌اوت هر تلاش بر حسب میلی‌ثانیه |
| `[max_retries=100]` | `retries` | سقف تلاش مجدد هر درخواست (حداکثر ۱۰۰۰) |
| `[temperature=0.7]` | — | فیلد `temperature` را روی بدنه‌های JSON قفل می‌کند |
| `[reasoning=high]` | `reasoning_effort`، `effort`، `thinking` | شدت استدلال/تفکر — پایین‌تر توضیح داده شده |
| `[header=X-Custom: abc]` | قابل تکرار | افزودن هدر دلخواه به درخواست بالادست |

در مقدار دایرکتیوها نمی‌توان از `]` استفاده کرد؛ نام دایرکتیوها به بزرگی و کوچکی حروف حساس نیستند (`[MODEL=x]`) ولی مقدارها با حروف اصلی خودشان ارسال می‌شوند.

**دایرکتیوها کجا دنبال می‌شوند؟** (اولویت با اولین منبع): متن بدنهٔ درخواست ← پارامترهای کوئری (`?provider=…&key=…&model=…`) ← هدرهای `X-Relay-*` (`X-Relay-Provider`، `X-Relay-Model`، `X-Relay-Key`، …). دایرکتیوهای کوئری/هدر برای این‌اند که آپلودهای باینری (صدای STT که فیلد متنی ندارد) هم بتوانند سرویس‌دهنده را انتخاب کنند.

## شدت استدلال (reasoning effort)

هر سرویس‌دهنده «فکر کن عمیق‌تر» را به شکل دیگری می‌نویسد؛ برای همین `[reasoning=…]` فقط **قصد** شما را حمل می‌کند و رله آن را در فیلدی می‌نویسد که API مقصد واقعاً می‌پذیرد. مقادیر: `none` (خاموش) · `minimal` · `low` · `medium` · `high` · `xhigh` · `max` · `default` (پیش‌فرض خود سرویس‌دهنده دست‌نخورده می‌ماند) · یا یک بودجهٔ صریح توکن مثل `[reasoning=8192]`. نام مستعار خود دایرکتیو: `reasoning_effort`، `effort`، `thinking`؛ مقدارها هم مترادف‌های آشنا را می‌پذیرند (`off`/`false`، `min`، `med`، `x-high`، `ultra`، `on`).

| مقصد | رله در بدنه چه می‌نویسد |
|---|---|
| OpenAI chat completions، Azure، xAI، Groq، حالت سازگار OpenAI در Gemini، گیت‌وی‌های عمومی | `reasoning_effort: "high"` |
| Responses API اوپن‌ای‌آی | `reasoning: { effort: "high" }` (با فیلد شما ادغام می‌شود — `summary`/`mode` شما حفظ می‌شود) |
| Anthropic Messages | `thinking: { type: "enabled", budget_tokens }`، یا برای Claude 4.7 به بعد `thinking: { type: "adaptive" }` + `output_config: { effort }` |
| `generateContent` نیتیو Gemini | `generationConfig.thinkingConfig.thinkingBudget` (و `thinkingLevel` از طریق کانفیگ) |
| OpenRouter (تشخیص از هاست) | `reasoning: { effort }` یا `reasoning: { max_tokens }` — OpenRouter فیلد تخت (flat) را **نمی‌پذیرد** |
| Z.ai / GLM (تشخیص از هاست) | `thinking: { type }` + `reasoning_effort` |
| images / videos / tts / stt / embeddings / rerank | هیچ — این APIها پارامتر استدلال ندارند؛ پس دایرکتیو با یک هشدار نادیده گرفته می‌شود تا بدنه خراب نشود |

قواعد عددی الزام‌آورند، نه حدسی: `budget_tokens` کلود از `max_tokens` خودِ درخواست مشتق می‌شود (۰٫۱ تا ۰٫۹۵ بسته به سطح)، کفش ۱۰۲۴ است و همیشه زیر `max_tokens` نگه داشته می‌شود تا برای جواب جا بماند — اگر `max_tokens` برای یک بودجهٔ قانونی کوچک باشد، دایرکتیو با هشدار رد می‌شود و درخواستِ قابل‌ردرفت فرستاده نمی‌شود. Gemini از نگاشتِ مستندِ خود گوگل بین سطح و بودجه استفاده می‌کند (minimal/low: ۱۰۲۴، medium: ۸۱۹۲، high: ۲۴۵۷۶، خاموش: ۰). سرویس‌دهنده‌هایی که فقط سطح می‌پذیرند، وقتی بودجهٔ خام بدهید نزدیک‌ترین سطح را می‌گیرند.

شدت استدلال در توکن‌های نشست هم سفر می‌کند، پس زیرعامل‌ها آن را به ارث می‌برند (پایین‌تر). تشخیص خودکار را با `RELAY_REASONING_STYLE` (`effort`/`responses`/`anthropic`/`gemini`/`openrouter`/`glm`/`off`) بازنویسی کنید، شکل مخصوص Claude را با `RELAY_REASONING_ANTHROPIC_MODE` (`auto`/`budget`/`adaptive`) انتخاب کنید، یا کل قابلیت را با `RELAY_REASONING=false` خاموش کنید.

## مسیریابی بدون همکاریِ کلاینت

دایرکتیوهای درون‌پرامپت فقط در متنی وجود دارند که **کاربر** نوشته. رله سه مکانیزم اضافه دارد تا مسیریابی حتی وقتی هیچ‌کس چیزی را برنمی‌گرداند زنده بماند:

### حافظهٔ IP

وقتی یک درخواست دایرکتیوهایش حل می‌شود، رله آن‌ها را برای IP صداکننده به یاد می‌سپارد (TTL سرگردان ۲۴ ساعته). درخواست‌های بعدیِ همان IP که *هیچ* دایرکتیوی ندارند — زیرعامل‌ها، پیام‌های بعد از فشرده‌سازی — سرویس‌دهنده، مدل، compatibility، شدت استدلال و کلید را خودکار به ارث می‌برند:

</div>

```
request 1 (your IP): "hello [provider=https://api.b.ai/v1] [model=glm-5.3-flash] [key=sk-x] [reasoning=max]"
request 2 (same IP): {"model":"glm-5.3-flash","messages":[…]}   ← همه‌چیز اعمال شده
request (other IP):  ← هیچی به ارث نمی‌برد
```

<div dir="rtl">

- اولویت همچنان «اولین مورد برنده است»: **body > model flags > query > header > توکن نشست > حافظهٔ IP**. یک درخواست ناقص (مثلاً فقط `[model=other]`) فقط همان چه را نام برده بازنویسی می‌کند.
- IP **فقط** از `cf-connecting-ip` خوانده می‌شود که لبهٔ Cloudflare ست می‌کند و کلاینت نمی‌تواند جعلش کند. `X-Forwarded-For`/`X-Real-IP` نادیده گرفته می‌شوند مگر اینکه `RELAY_IP_TRUST_FORWARDED` را فعال کنید (فقط برای پراکسی‌های لوکال) — وگرنه هر کسی می‌توانست با جعل هدر، کلیدِ به‌یادماندهٔ IP دیگری را بدزدد.
- محدوده: این حافظه per-isolate است. سرور توسعهٔ همراه (یک پروسه) مرجع است؛ روی Cloudflare «تلاشِ بهینه» است — بیشتر درخواست‌ها به ایزولیتِ گرم می‌خورند، ولی برای تضمین قطعی، توکن نشستِ بدون حالت را برگردانید.
- نکته: همهٔ افراد پشت یک IP عمومی (NAT اداری، VPN) یک جایگاه مسیریابی مشترک دارند. با `RELAY_IP_MEMORY=false` خاموشش کنید.

### فلگ‌های نام مدل

کلاینت‌هایی که فقط می‌توانند یک رشتهٔ مدل ست کنند (بدون پرامپت، بدون هدر) می‌توانند مسیریابی را داخل خودِ نام مدل جاسازی کنند:

</div>

```
model: "glm-5.3-flash@https://api.b.ai/v1@key=sk-x"
```

<div dir="rtl">

هر فلگِ جدا‌شده با `@` یکی از این‌هاست: یک URL از نوع `http(s)` یا یک هاستِ بدون پروتکل (سرویس‌دهنده)، یک نام از `RELAY_NAMED_PROVIDERS`، یا `key=…`/`apikey=…`/`k=…`، یا `compatibility=…`/`compat=…`/`c=…`، یا `reasoning=…`/`effort=…`/`thinking=…` (هر سطحی، مستعاری، یا بودجهٔ توکن — مثلاً `model@provider@key=sk-x@reasoning=max`). سرویس‌دهنده **نام تمیزِ** مدل را می‌گیرد؛ هر سگمنت ناشناخته (مثل `weird@name`) رشته را دست‌نخورده می‌گذارد، پس نام‌های معمولی مدل که `@` دارند هیچ‌وقت خراب نمی‌شوند. فلگ‌ها بعدش به IP هم می‌چسبند و دایرکتیو متنیِ `[model=…]` همچنان اولویتِ اول را روی آن‌ها دارد.

### نشست‌های ماندگار: مسئلهٔ زیرعامل‌ها و فشرده‌سازی

دو موقعیت رایج دایرکتیوهای درون‌پرامپت را می‌شکنند:

- **زیرعامل‌ها**: وقتی یک ایجنت هوش مصنوعی زیرعامل می‌سازد، پرامپتِ زیرعامل را *مدل والد* می‌نویسد — و `[provider=…] [key=…]` را در آن کپی نمی‌کند. فراخوانی‌های API زیرعامل بدون هیچ مسیریابی‌ای به رله می‌خورند.
- **فشرده‌سازی (compaction)**: گفتگوهای طولانی خلاصه می‌شوند؛ خلاصهٔ نوشته‌شده توسط مدل ممکن است دایرکتیوها را جا بیندازد.

رله این را با **توکن‌های نشستِ بدون حالت** حل می‌کند:

1. هر پاسخی که دایرکتیو داشته، هدر `X-Relay-Session: rls1_<payload>.<tag>` برمی‌گرداند — یک توکن امضاشده که سرویس‌دهنده، مدل، compatibility، شدت استدلال و کلید را در خود دارد (وقتی `RELAY_SESSION_SECRET` ست شده باشد با AES-GCM **رمز** می‌شود؛ وگرنه base64 خوانا است — در هر دو حالت با توکن‌ها مثل کلید API رفتار کنید).
2. هر درخواست بعدی با برگرداندن همان توکن آن دایرکتیوها را به ارث می‌برد — از طریق هدر `X-Relay-Session`، یا `?relay_session=`، یا کوکی `relay_session` (برای مرورگرها خودکار ست می‌شود)، یا حتی **با اینکه مدل والدِ توکن را داخل پرامپت زیرعامل پیست کند** — رله آن را مثل هر دایرکتیوی می‌شناسد و پاک می‌کند.
3. اولویت همچنان «اولین مورد برنده است»: body > query > header > نشست. دایرکتیوهای سطح درخواست همیشه می‌برند؛ نشست فقط حفره‌ها را پر می‌کند. توکن‌ها منقضی می‌شوند (پیش‌فرض ۷ روز، تمدید سرگردان) و در هر پاسخِ واجد شرایط دوباره صادر می‌شوند.


هیچ بایندینگ KV یا Durable Object لازم نیست — دایرکتیوها داخل خود توکن سفر می‌کنند.

### سرویس‌دهنده‌های نام‌دار (آدرس پایه یک‌بار برای همیشه کانفیگ می‌شود)

مطمئن‌ترین گزینه: بدون هیچ دایرکتیوی در هیچ‌جا.

</div>

```toml
# wrangler.toml
[vars]
RELAY_NAMED_PROVIDERS = "openai=https://api.openai.com/v1, anthropic=https://api.anthropic.com"
```

<div dir="rtl">

بعد هارنس ایجنتی‌تان (و هر زیرعاملی که می‌سازد) را روی `https://<worker>/openai` به‌عنوان base URL ببرید و کلید سرویس‌دهنده را بگذارید API key — مسیریابی برای هر درخواستی کار می‌کند، فارغ از رفتار مدل، فشرده‌سازی یا بازنویسی پرامپت. `?provider=openai` و `[provider=openai]` هم از همان نگاشت گسترش می‌یابند.

## اَندپوینت‌ها و مسیرها

URL بالادست برابر است با `provider_base` + مسیر ورودی، به شکلی به هم می‌چسبند که هرگز `/v1/v1/…` تولید نشود:

| مسیر ورودی | `[provider=…]` | خروجی |
|---|---|---|
| `/v1/chat/completions` | `https://api.p.com/v1` | `https://api.p.com/v1/chat/completions` |
| `/v1/chat/completions` | `https://api.p.com` | `https://api.p.com/v1/chat/completions` |
| `/v1/chat/completions` | `https://api.p.com/v1beta/openai` | `https://api.p.com/v1beta/openai/chat/completions` |
| `/v1/messages` | `https://api.p.com` (با compat `anthropic`) | `https://api.p.com/v1/messages` |

کوئری‌استرینگ‌ها حفظ می‌شوند (`/v1/models?limit=100` همان `?limit=100` را نگه می‌دارد). هر مسیر ناشناخته‌ای عیناً قابل پراکسی است. `GET /` سند راهنما را برمی‌گرداند؛ `GET /__relay/health` بررسی سلامت است.

## سامانهٔ تلاش مجدد

روی `408 425 429 500 502 503 504 507 509 520-527 529 530` و خطاهای سطح fetch (DNS، قطع اتصال، تایم‌اوت — از جمله تایم‌اوت هر تلاشِ خودِ رله) تلاش مجدد می‌شود. روی `400 401 403 404 405 409 413 415 422` تلاش مجدد **نمی‌شود** — این‌ها عیناً و بدون تغییر به شما برمی‌گردند.

- Backoff نمایی به شکل `base * 2^attempt` با سقف `maxDelayMs`، جیتر کامل و کف ۵۰ میلی‌ثانیه.
- `Retry-After` محترم شمرده می‌شود (به شکل ثانیه یا تاریخ HTTP، با سقف).
- `[max_retries=…]` بودجهٔ هر درخواست را بازنویسی می‌کند؛ پیش‌فرض دیپلوی `10000` تلاش است که در عمل با سقف subrequest کلادفلر (۵۰ در پلن رایگان / ۱۰۰۰ در پولی) محدود می‌شود — حلقه پیام `"Too many subrequests"` را تشخیص می‌دهد و تمیز با `subrequest_limit` شکست می‌خورد.
- **پاسخی که اولین بایتش به کلاینت رسیده، دیگر هرگز retry نمی‌شود** — دو استریم SSE هرگز به هم دوخته نمی‌شوند.
- قطع اتصال کلاینت حلقه را بلافاصله متوقف می‌کند.
- ریدایرکت‌ها توسط خودِ رله دنبال می‌شوند (حداکثر ۳، قابل تنظیم) تا **هر پرش دوباره با سیاست SSRF چک شود**؛ پرش‌های بین‌دامنه‌ای credentialهای خود را می‌اندازند، مثل fetch استاندارد.

## شفاف در طراحی

فقط فیلدهای متنی اسکن و بازنویسی می‌شوند (`prompt`، `text`، `input`، `content`، `query`، `messages`، …). این‌ها **هرگز** دست نمی‌خورند و حتی بیشتر پارس نمی‌شوند: `url`، `image_url`، `video_url`، `base64`، `data`، `bytes`، `file(s)`، `attachments`، `media`، `tools`، `response_format`، `api_key`، `authorization`، … — پس payloadهای بینایی، اسکیماهای ویدیوی مخصوص هر سرویس‌دهنده، تعریف ابزارها و افزونه‌های ناشناخته عیناً همان‌طور که فرستاده‌اید به مقصد می‌رسند. آپلودهای multipart فقط وقتی بازسازی می‌شوند که یک دایرکتیو واقعاً فیلد متنی را عوض کرده باشد (تا `fetch` مرز multipart را از نو بسازد)؛ بدنه‌های باینری کوچک برای قابل‌retry‌بودن بافر می‌شوند؛ هرچه بزرگ‌تر است در یک تلاش استریم می‌شود.

## نمونه‌های بیشتر

### Responses API

</div>

```bash
curl https://myworker.example.workers.dev/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"input":"Summarize this [provider=https://api.provider.com/v1] [compatibility=responses] [model=o4-mini]"}'
```

<div dir="rtl">

### Anthropic

</div>

```bash
curl https://myworker.example.workers.dev/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "max_tokens": 1024,
    "messages": [{
      "role": "user",
      "content": "مرحبا [provider=https://api.anthropic-compatible.com] [compatibility=anthropic] [key=sk-ant-xxx] [model=claude-sonnet-4]"
    }]
  }'
```

<div dir="rtl">

احراز هویت تبدیل می‌شود به `x-api-key: sk-ant-xxx` + `anthropic-version: 2023-06-01` (فقط اگر خودتان نفرستاده باشید اضافه می‌شود).

### بینایی (Vision)

</div>

```bash
curl https://myworker.example.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "describe this [provider=https://api.provider.com/v1] [model=gpt-5-vision]"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo…"}}
      ]
    }]
  }'
```

<div dir="rtl">

تصویر base64 دست نمی‌خورد.

### TTS (پاسخ باینری استریم می‌شود)

</div>

```bash
curl -o speech.mp3 https://myworker.example.workers.dev/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"tts-1","input":"Hello there [provider=https://api.provider.com/v1] [model=tts-1-hd]"}'
```

<div dir="rtl">

### STT (آپلود multipart)

</div>

```bash
curl https://myworker.example.workers.dev/v1/audio/transcriptions \
  -F "file=@speech.wav" \
  -F "model=whisper-1" \
  -F 'prompt=transcribe in Persian [provider=https://api.provider.com/v1] [model=whisper-large-v3] [key=sk-xxx]'
```

<div dir="rtl">

سرویس‌دهنده‌های باینری که فیلد متنی ندارند می‌توانند از دایرکتیوهای کوئری استفاده کنند: `POST /v1/audio/transcriptions?provider=https://…&key=…`.

<details>
<summary><strong>سناریوهای پارس و تلاش مجدد</strong></summary>

| ورودی | نتیجه |
|---|---|
| `hello [model=N] idk [model=G]` | مدل `N`، متنِ تمیز‌شده `hello  idk` |
| `[provider=https://a.com/v1] … [provider=https://b.com/v1]` | سرویس‌دهندهٔ `a.com` می‌برد |
| `[apikey=first] [key=second]` | `first` می‌برد |
| `see [docs](https://x.com) [model=y]` | لینک دست‌نخورده، `model=y` اعمال می‌شود |
| سرویس‌دهنده سه بار `429` می‌دهد بعد `200` | با backoff/`Retry-After` تلاش مجدد، پاسخ چهارم استریم می‌شود، `X-Relay-Attempts: 4` |
| سرویس‌دهنده `401` می‌دهد | بلافاصله برمی‌گردد، بدون تغییر، بدون retry |
| سرویس‌دهنده همیشه `503` می‌دهد | `relay_error` / `retry_exhausted` با وضعیت خود سرویس‌دهنده و شمار تلاش‌ها |
| سرویس‌دهنده `http://127.0.0.1:8000`، `https://192.168.1.1`، `https://169.254.169.254` یا `[::1]` باشد | قبل از هر اتصالی رد می‌شود (`blocked_provider`) |
| `[provider=hello]` | `invalid_provider` |

</details>

## پیکربندی

هر چیزی در `BASE_CONFIG` را می‌توان با متغیرهای متنی Worker بازنویسی کرد (داشبورد ← **Settings → Variables**، یا `[vars]` در `wrangler.toml`):

<details open>
<summary><strong>همهٔ متغیرهای <code>RELAY_*</code></strong></summary>

| متغیر | پیش‌فرض | معنی |
|---|---|---|
| `RELAY_DEFAULT_PROVIDER` | `""` | جایگزین وقتی هیچ `[provider=…]`ای نیست (خالی = `400 missing_provider`) |
| `RELAY_PROVIDER_ALLOWLIST` | `""` (همه) | هاست‌های جداشده با کاما/فاصله، وایلدکارد `*.suffix` مجاز است |
| `RELAY_ALLOW_HTTP` | `false` | اجازهٔ بالادست‌های `http://` (فقط توسعه) |
| `RELAY_ALLOW_PRIVATE_NETWORKS` | `false` | اجازهٔ بالادست‌های loopback/RFC1918 (فقط توسعه) |
| `RELAY_MAX_ATTEMPTS` | `10000` | بودجهٔ تلاش مجدد |
| `RELAY_BASE_DELAY_MS` / `RELAY_MAX_DELAY_MS` / `RELAY_MIN_DELAY_MS` | `250/30000/50` | شکل backoff |
| `RELAY_ATTEMPT_TIMEOUT_MS` | `0` (خاموش) | تایم‌اوت هر تلاش |
| `RELAY_RETRY_BUDGET_MS` | `0` (خاموش) | بودجهٔ زمان‌سنج تلاش مجدد |
| `RELAY_HONOR_RETRY_AFTER` / `RELAY_MAX_RETRY_AFTER_MS` | `true` / `60000` | نحوهٔ برخورد با `Retry-After` |
| `RELAY_MAX_REDIRECTS` | `3` | پرش‌های ریدایرکتِ چک‌شده با SSRF (۰ = خود 3xx برگردد) |
| `RELAY_MAX_JSON_BYTES` / `RELAY_MAX_MULTIPART_BYTES` / `RELAY_MAX_TEXT_BYTES` / `RELAY_MAX_BUFFER_BYTES` | `24/24/8/24 MB` | سقف بدنه‌ها (۰ بافرِ opaque را خاموش می‌کند) |
| `RELAY_CORS_ORIGIN` / `RELAY_CORS_HEADERS` / `RELAY_CORS_CREDENTIALS` | `*` / `*` / `false` | CORS |
| `RELAY_FORWARD_INCOMING_AUTH` | `true` | پاس‌دادن `Authorization` صداکننده وقتی `[key=…]`ای نیست |
| `RELAY_STRIP_PATH_PREFIX` | `""` | حذف مثلاً `/relay` از ابتدای مسیر ورودی |
| `RELAY_ACCEPT_QUERY_DIRECTIVES` / `RELAY_ACCEPT_HEADER_DIRECTIVES` | `true` / `true` | منابع ثانویهٔ دایرکتیو |
| `RELAY_SESSIONS` / `RELAY_SESSION_TTL_SECONDS` / `RELAY_SESSION_SECRET` / `RELAY_SESSION_INCLUDE_KEY` / `RELAY_SESSION_COOKIE` | `true` / `604800` / `""` / `true` / `true` | توکن‌های نشست ماندگار (برای رمزنگاری‌شان یک secret ست کنید) |
| `RELAY_IP_MEMORY` / `RELAY_IP_MEMORY_TTL_SECONDS` / `RELAY_IP_MEMORY_MAX_ENTRIES` / `RELAY_IP_MEMORY_INCLUDE_KEY` | `true` / `86400` / `10000` / `true` | دایرکتیوهایی که به IP صداکننده می‌چسبند |
| `RELAY_IP_TRUST_FORWARDED` | `false` | اعتماد به `X-Forwarded-For`/`X-Real-IP` برای IP کلاینت (فقط پراکسی‌های لوکال — وگرنه قابل جعل است) |
| `RELAY_NAMED_PROVIDERS` | `""` | نام‌های مستعار مسیر/کوئری برای سرویس‌دهنده‌ها: `name=https://provider/v1,…` |
| `RELAY_REASONING` / `RELAY_REASONING_STYLE` / `RELAY_REASONING_ANTHROPIC_MODE` / `RELAY_REASONING_GEMINI_FIELD` | `true` / `auto` / `auto` / `thinkingBudget` | نگاشت شدت استدلال |
| `RELAY_REASONING_MIN_BUDGET` / `RELAY_REASONING_MAX_BUDGET` | `1024` / `128000` | محدودهٔ گیرش بودجهٔ تفکر |
| `RELAY_VERSION_PREFIX_MODE` | `smart` | نحوهٔ چسباندن مسیر: `smart` / `drop` / `keep` |
| `RELAY_DEBUG` | `false` | لاگ پرحجم (بدون هیچ رازی) |
| `RELAY_DIAGNOSTIC_HEADERS` | `true` | هدرهای پاسخ `X-Relay-*` |

</details>

## ملاحظات امنیتی

- **SSRF**: به‌صورت پیش‌فرض فقط سرویس‌دهنده‌های `https://` (با `RELAY_ALLOW_HTTP=true` برای توسعهٔ لوکال http را باز کنید). مسدود: loopback و تمام بازه‌های خصوصی/رزرو IPv4، loopback/link-local/unique-local/NAT64/6to4 در IPv6 با آدرس‌های خصوصیِ داخل‌شان، هاست‌های متادیتای کلود، پسوندهای سبک `.internal`/`.local` و نام‌های تک‌قسمتیِ اینترانت — در نمای اعشاری، اکتال، هگز و ترکیبی. ریدایرکت‌ها توسط خود رله دنبال می‌شوند تا هر پرش دوباره چک شود؛ پرش‌های بین‌دامنه‌ای credentialهای خود را می‌اندازند. URLهای دارای `user:pass@` رد می‌شوند.
  - *محدودیت شناخته‌شده*: نام DNS عمومی که به آدرس خصوصی resolve می‌شود (DNS rebinding) از داخل Worker قابل تشخیص نیست — برای تضمین قطعی از `RELAY_PROVIDER_ALLOWLIST` استفاده کنید.
- **لیست مجاز**: `RELAY_PROVIDER_ALLOWLIST="api.openai.com,*.openai.azure.com"` هر درخواست (و هر پرش ریدایرکت) را به همان هاست‌ها محدود می‌کند. سیاست شبکهٔ خصوصی حتی داخل لیست مجاز هم اعمال می‌شود.
- **رازها**: `[key=…]` هرگز به متنِ مدل، پاسخ‌های خطا یا لاگ‌ها نمی‌رسد (لاگ‌های دیباگ فقط `***` نشان می‌دهند). پاسخ‌های خطا هرگز محتوای پرامپت را بازگو نمی‌کنند. پارامترهای کوئریِ مصرف‌شدهٔ `?key=` و `?relay_session=` از URL ارسالی پاک می‌شوند. کوکی‌ها و هدرهای `CF-*`/`X-Forwarded-*`/`X-Real-IP` هرگز به بالادست فوروارد نمی‌شوند. توکن‌های نشست کلیدِ صداکننده را با خود حمل می‌کنند — `RELAY_SESSION_SECRET` را ست کنید تا به‌جای base64 خوانا با AES-GCM رمز شوند، و در هر دو حالت با آن‌ها مثل راز رفتار کنید.
- **CORS**: به‌صورت پیش‌فرض باز (`Access-Control-Allow-Origin: *` — این یک رلهٔ عمومی است، همان‌طور با آن رفتار کنید). حالت credential فهرست صریح origin می‌خواهد و گرنه نادیده گرفته می‌شود.
- **DoS**: اسکنر دایرکتیو یک پارسر خطی با بودجهٔ محدود است (بدون backtracking رجکس)؛ پیمایش JSON و اسکن رشته‌ها سقفِ گره/عمق/طول دارند؛ خواندن بدنه وسط استریم سقف دارد؛ بودجهٔ retry هر درخواست حداکثر ۱۰۰۰ است.
- این Worker را پشت دامنه‌ای که برای ابزارهای مدیریتی داخلی‌تان هم استفاده می‌کنید **نگذارید**؛ این به‌صورت طراحی‌شده یک رلهٔ فورواردِ باز به هاست‌های عمومی HTTPS است.

## محدودیت‌های پلتفرم Cloudflare (حتماً بخوانید)

**«تلاش مجدد بی‌نهایت» تلاشِ بهینه است، نه تضمین — محدودیت از خودِ پلتفرم می‌آید.** حلقه تا وقتی فراخوانی زنده است retry می‌کند، اما هیچ Worker‌ای نمی‌تواند retry نامحدود را تضمین کند چون:

- **بودجهٔ subrequest**: ۵۰ درخواست خروجی به‌ازای هر فراخوانی در پلن رایگان، ۱۰۰۰ در پولی. هر retry و هر پرش ریدایرکت یکی مصرف می‌کند. وقتی تمام شود Cloudflare خطا می‌دهد و رله به‌جای تظاهر، `subrequest_limit` برمی‌گرداند.
- **زمان CPU**: حدود ۱۰ میلی‌ثانیه رایگان / ۳۰ ثانیه پولی (قابل تنظیم). خوابیدن بین retryها رایگان است، ولی اسکن/پارس CPU می‌بلعد.
- **اتصال کلاینت**: اگر صداکننده برود، رله فوراً می‌ایستد — retry برای کلاینتی که قطع شده بی‌معنی است.
- **بدنه‌های یک‌بارمصرف**: آپلود استریم‌شده قابل پخش مجدد نیست، پس آن درخواست‌ها دقیقاً یک تلاش می‌گیرند.
- **حافظه**: ۱۲۸ مگابایت برای هر ایزولیت. خواندن بدنه حین خواندن سقفِ سخت دارد (پیش‌فرض ۲۴ مگابایت) تا `Content-Length` دروغگو حافظه را نکشد.

## معماری (بخش‌های `worker.js`)

<details>
<summary><strong>نقشهٔ بخش‌ها</strong></summary>

- **۱ — پیکربندی** (`BASE_CONFIG` + متغیرهای `RELAY_*`، حل‌شده به‌ازای هر درخواست)
- **۲ — ثابت‌ها** (رجیستری دایرکتیوها، جدول compatibility، مجموعه نام فیلدها، بلک‌لیست‌های SSRF)
- **۳ — ابزارهای کوچک** (پارسرهای تایپ‌دار مقدار دایرکتیو، پارس env)
- **۴ — CORS**
- **۵ — کمک‌کننده‌های خطا** (پاسخ‌های ساخت‌یافتهٔ `relay_error`)
- **۶ — پارس دایرکتیو** (اسکنر خطی، وضعیت اولین-برنده)
- **۶b — توکن‌های نشست** (دایرکتیوهای ماندگار برای زیرعامل‌ها و فشرده‌سازی)
- **۶c — حافظهٔ IP** (دایرکتیوهایی که به IP صداکننده می‌چسبند)
- **۷ — پیمایش JSON** (کپی‌درنوشتن، اسکن محتاطانهٔ فیلدهای متنی، فیلدهای محافظت‌شده)
- **۸ — آماده‌سازی بدنهٔ درخواست** (JSON / multipart / urlencoded / text / opaque، با سقف سخت خواندن)
- **۹ — تشخیص compatibility** (دایرکتیو ← مسیر ← عمومی)
- **۱۰ — اعتبارسنجی URL سرویس‌دهنده + محافظت SSRF**
- **۱۱ — چسباندن مسیر**
- **۱۲ — هدرهای احراز هویت**
- **۱۳ — پاک‌سازی هدرها**
- **۱۴ — محاسبات retry**
- **۱۵ — پارسر `Retry-After`**
- **۱۶ — fetch بالادست + حلقهٔ retry**
- **۱۷ — ساخت پاسخ**
- **۱۸ — هندلر درخواست**
- **۱۹ — `export default { fetch }`**

</details>

## اجرای لوکال

دو راه دارید:

### گزینهٔ A — سرور توسعهٔ بدون نصب (فقط Node)

</div>

```bash
node dev-server.mjs            # یا: npm run dev  →  http://localhost:8787
PORT=9000 node dev-server.mjs  # پورت دلخواه (همچنین: --port 9000)
```

<div dir="rtl">

`dev-server.mjs` سرور HTTP نود را به API ورکر وفق می‌دهد؛ پس **همان `worker.js` که روی Cloudflare دیپلوی می‌شود** روی سیستم شما هم اجرا می‌شود. برای راحتی، پیش‌فرضش `RELAY_ALLOW_HTTP=true` و `RELAY_ALLOW_PRIVATE_NETWORKS=true` است تا بتوانید `[provider=…]` را به یک سرویس لوکال بزنید (مثل Ollama، LM Studio یا هر سرور سازگار با OpenAI) — این متغیرها را `false` کنید تا رفتار SSRF عملیات را هم تمرین کنید. هر درخواست با وضعیت و مدت‌زمان لاگ می‌شود.

### گزینهٔ B — wrangler dev (نزدیک‌ترین به عملیات)

</div>

```bash
npx wrangler dev     # از wrangler.toml استفاده می‌کند؛ روی http://localhost:8787
```

<div dir="rtl">

این ورکر را داخل ران‌تایم واقعی `workerd` اجرا می‌کند، پس جزئیات پلتفرم (سیگنال‌های قطع درخواست، خطاهای بودجهٔ subrequest، رفتار استریم، هندل WebSocket) با عملیات یکسان است. برای رسیدن به سرویس‌دهنده‌های لوکال از این راه هم، به `wrangler.toml` اضافه کنید:

</div>

```toml
[vars]
RELAY_ALLOW_HTTP = "true"
RELAY_ALLOW_PRIVATE_NETWORKS = "true"
```

<div dir="rtl">

> نکته: `wrangler dev` به‌صورت پیش‌فرض پورت 8787 را می‌بندد. اگر چیز دیگری آن‌جاست، `wrangler dev --port 8790` را بزنید (و `PORT=8790` برای سرور توسعه).

### تست‌ها

</div>

```bash
npm test    # 186 تست: unit (57) + reasoning (26) + sessions (11) + ip-memory (17) + integration (75)
```

<div dir="rtl">

دو رفتار لوکال ارزش دانستن دارد:

- **پورت‌های اشغال هندل می‌شوند**: اگر 8787 گرفته شده (مثلاً توسط یکی از `wrangler dev`های دیگرتان)، سرور توسعه می‌گوید کدام پروسه نگهش داشته و خودکار به اولین پورت آزاد می‌رود. هر وقت خواستید با `PORT=…` / `--port` بازنویسی کنید.
- **معنای شکست فرق دارد**: هاستی که resolve نمی‌شود (غلط تایپی) سریع با `502 upstream_error / dns_not_found` می‌بازد. هاستی که *اتصال را رد می‌کند* (سرویس پایین است) طبق طراحی تا بی‌نهایت retry می‌شود — در حین توسعهٔ روی چیزی که ممکن است بالا نباشد، `[timeout=…]` را به پرامپت بدهید یا `RELAY_ATTEMPT_TIMEOUT_MS` را ست کنید.

مجموعهٔ تست همهٔ ۱۵ سناریوی spec را پوشش می‌دهد (پارس اولین-برنده، یونیکد، حفظ vision/video، باینری TTS، STT چندبخشی، تأخیر استریم SSE، retry روی 429، عبور مستقیم 401، ردشدن‌های SSRF، سرویس‌دهنده‌های بدشکل) به‌علاوهٔ رگرسیون‌های همهٔ یافته‌های سه بازبینی مستقل (اسکنِ محدود به CPU، آلودگی prototype، درآوردن credential در ریدایرکت، سقف خواندن بدنه، ترتیب لیست مجاز، عبور Set-Cookie/Content-Encoding و موارد دیگر).

توجه کنید تست‌های یکپارچه روی Node (undici) اجرا می‌شوند؛ چند جزئیات ران‌تایم روی workerd فرق دارد — مخصوصاً عبور WebSocket (`Upgrade: websocket`) تلاشِ بهینه است و بعد از دیپلوی یک تست دستیِ دودی به‌درد می‌خورد.

---

[English](README.md) · **فارسی**

</div>
