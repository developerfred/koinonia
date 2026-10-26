import fs from "node:fs";
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const users = Array.from({ length: 40 }, (_, i) => `viewer${i}`);
const U = () => users[Math.floor(rnd() * users.length)];
const chat = [], audio = [], transcript = [], events = [];
const calm = ["oi", "boa noite", "qual o jogo?", "bom demais", "interessante", "concordo", "primeira vez aqui", "como configura isso?"];
const hype = ["KEKW", "POGGERS", "kkkkkkk", "LUL", "GG", "INSANE", "OMEGALUL", "NOOOO"];
for (let t = 0; t < 600_000; t += 2000 + Math.floor(rnd() * 1500)) chat.push({ tMs: t, user: U(), text: calm[Math.floor(rnd() * calm.length)] });
const burst = (t0, n, span, pool, emotes) => { for (let i = 0; i < n; i++) { const text = pool[Math.floor(rnd() * pool.length)]; chat.push({ tMs: t0 + Math.floor((i / n) * span), user: U(), text, ...(emotes ? { emotes: [text] } : {}) }); } };
burst(120_000, 30, 5000, hype, true);   // loud + hype
burst(250_000, 4, 5000, calm, false);   // quiet moment: tiny chat bump only
burst(400_000, 14, 8000, ["bem vindo raiders!", "RAID", "olá", "KEKW"], false);
burst(500_000, 12, 8000, ["1", "2", "1", "opção 1", "2"], false);
for (let t = 0; t < 600_000; t += 500) audio.push({ tMs: t, db: Math.round((-30 + (rnd() - 0.5) * 4) * 10) / 10 });
for (let t = 120_000; t < 123_000; t += 500) audio[t / 500].db = -11.5;
const talk = ["então a ideia hoje é montar o setup", "a gente vai ver como a configuração funciona", "isso depende do hardware que você tem", "vou mostrar o próximo passo agora", "funciona bem com a maioria dos casos"];
for (let t = 0; t < 600_000; t += 8000) { if (t >= 300_000 && t < 330_000) continue; transcript.push({ startMs: t, endMs: t + 6000, text: talk[(t / 8000) % talk.length] }); }
transcript.push({ startMs: 250_000, endMs: 255_000, text: "Espera, o segredo é esse, eu não acredito que funcionou", words: "Espera, o segredo é esse, eu não acredito que funcionou".split(" ").map((w, i) => ({ text: w, startMs: 250_000 + i * 450, endMs: 250_000 + i * 450 + 400, confidence: 0.95 })) });
transcript.push({ startMs: 120_000, endMs: 123_000, text: "Meu deus!! Conseguimos!!" });
events.push({ tMs: 0, type: "scene" }, { tMs: 200_000, type: "scene" }, { tMs: 400_000, type: "raid", data: { viewers: 120 } }, { tMs: 450_000, type: "scene" }, { tMs: 490_000, type: "poll_start" }, { tMs: 505_000, type: "poll_end", data: { votes: 85 } });
chat.sort((a, b) => a.tMs - b.tMs);
transcript.sort((a, b) => a.startMs - b.startMs);
fs.writeFileSync("test/fixtures/session.json", JSON.stringify({ startMs: 0, endMs: 600_000, chat, audio, transcript, events }));
