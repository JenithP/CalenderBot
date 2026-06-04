// ────────────────────────────────────────────────────────────────
//  텔레그램 → Netlify Functions → 구글 캘린더 → 텔레그램
//  개인용 일정 알림 봇
// ────────────────────────────────────────────────────────────────
const { JWT } = require("google-auth-library");

// 한국 시간(Asia/Seoul)은 항상 UTC+9, 서머타임 없음
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];

// ── 환경변수 ─────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
// Netlify 환경변수에 줄바꿈이 \n 문자로 들어가므로 실제 줄바꿈으로 복원
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

// ── 날짜 계산 (KST 기준) ─────────────────────────────────────────
// 오늘 0시 ~ 다음날 0시 (KST) 구간을 UTC Date 로 반환
function todayRange() {
  const seoulNow = new Date(Date.now() + KST_OFFSET_MS);
  const y = seoulNow.getUTCFullYear();
  const m = seoulNow.getUTCMonth();
  const d = seoulNow.getUTCDate();
  const startMs = Date.UTC(y, m, d, 0, 0, 0) - KST_OFFSET_MS;
  return { start: new Date(startMs), end: new Date(startMs + 24 * 60 * 60 * 1000) };
}

// 이번 주 월요일 0시 ~ 다음 주 월요일 0시 (KST)
function weekRange() {
  const seoulNow = new Date(Date.now() + KST_OFFSET_MS);
  const y = seoulNow.getUTCFullYear();
  const m = seoulNow.getUTCMonth();
  const day = seoulNow.getUTCDay();            // 0(일) ~ 6(토)
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const d = seoulNow.getUTCDate() + diffToMonday;
  const startMs = Date.UTC(y, m, d, 0, 0, 0) - KST_OFFSET_MS;
  return { start: new Date(startMs), end: new Date(startMs + 7 * 24 * 60 * 60 * 1000) };
}

// UTC Date → KST "HH:MM"
function fmtTime(date) {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  const hh = String(k.getUTCHours()).padStart(2, "0");
  const mm = String(k.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// UTC Date → KST "6월 4일 (목)"
function fmtDateHeader(date) {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  return `${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일 (${WEEKDAYS_KO[k.getUTCDay()]})`;
}

// 종일 일정 여부 판단용: KST 기준 날짜 키 "YYYY-MM-DD"
function dayKey(date) {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  return `${k.getUTCFullYear()}-${k.getUTCMonth()}-${k.getUTCDate()}`;
}

// ── 구글 캘린더 호출 ─────────────────────────────────────────────
async function getEvents(timeMin, timeMax) {
  const client = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });
  const { token } = await client.getAccessToken();

  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/` +
    `${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events?${params.toString()}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar API ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.items || [];
}

// ── 메시지 포맷팅 ────────────────────────────────────────────────
// 종일 일정: start.date 존재 / 시간 일정: start.dateTime 존재
function isAllDay(ev) {
  return !!(ev.start && ev.start.date && !ev.start.dateTime);
}

function eventLine(ev) {
  const title = (ev.summary || "(제목 없음)").trim();
  if (isAllDay(ev)) return `🔸 종일  ${title}`;
  const t = fmtTime(new Date(ev.start.dateTime));
  return `🕒 ${t}  ${title}`;
}

function formatToday(events) {
  if (events.length === 0) {
    return "📭 오늘은 등록된 일정이 없어요. 푹 쉬세요! ☕";
  }
  const lines = events.map(eventLine);
  return `📅 오늘 일정이에요!\n\n${lines.join("\n")}`;
}

function formatWeek(events) {
  if (events.length === 0) {
    return "📭 이번 주는 등록된 일정이 없어요. 여유로운 한 주네요! 🌿";
  }
  // 날짜별로 그룹핑
  const groups = new Map();
  for (const ev of events) {
    const startRaw = ev.start.dateTime || ev.start.date;
    const date = new Date(startRaw);
    const key = dayKey(date);
    if (!groups.has(key)) groups.set(key, { date, items: [] });
    groups.get(key).items.push(ev);
  }
  const blocks = [];
  for (const { date, items } of groups.values()) {
    const header = `📌 ${fmtDateHeader(date)}`;
    const lines = items.map((ev) => "   " + eventLine(ev));
    blocks.push(`${header}\n${lines.join("\n")}`);
  }
  return `🗓️ 이번 주 일정이에요!\n\n${blocks.join("\n\n")}`;
}

// ── 텔레그램 응답 전송 ───────────────────────────────────────────
async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}

// ── 명령 해석 ────────────────────────────────────────────────────
function detectIntent(text) {
  const t = (text || "").replace(/\s+/g, "");
  if (t.includes("이번주") || t.includes("주간") || t === "/week") return "week";
  if (t.includes("오늘") || t === "/today" || t === "/start") return "today";
  return "help";
}

// ── 핸들러 ───────────────────────────────────────────────────────
exports.handler = async (event) => {
  // 텔레그램 웹훅은 POST 로 옵니다.
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "ok" };
  }

  let update;
  try {
    update = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 200, body: "ok" };
  }

  const message = update.message || update.edited_message;
  if (!message || !message.chat) {
    return { statusCode: 200, body: "ok" };
  }

  const chatId = message.chat.id;
  const intent = detectIntent(message.text);

  try {
    if (intent === "today") {
      const { start, end } = todayRange();
      const events = await getEvents(start, end);
      await sendMessage(chatId, formatToday(events));
    } else if (intent === "week") {
      const { start, end } = weekRange();
      const events = await getEvents(start, end);
      await sendMessage(chatId, formatWeek(events));
    } else {
      await sendMessage(
        chatId,
        "안녕하세요! 👋\n\n아래처럼 보내주시면 일정을 알려드려요:\n\n" +
          "• 오늘 일정\n• 이번 주 일정"
      );
    }
  } catch (err) {
    console.error(err);
    await sendMessage(chatId, "⚠️ 일정을 가져오는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.");
  }

  // 텔레그램에는 항상 200 으로 응답해야 재전송이 발생하지 않습니다.
  return { statusCode: 200, body: "ok" };
};
