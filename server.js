require('express-async-errors'); // faz erros dentro de rotas async virarem resposta de erro
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool, types } = require('pg');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---------- CONFIGURAÇÃO (vem das "variáveis de ambiente" do Render) ----------
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();
if (!process.env.DATABASE_URL) { console.error('ERRO: falta a variável DATABASE_URL (endereço do Supabase).'); process.exit(1); }
if (!ADMIN_EMAIL) console.warn('AVISO: ADMIN_EMAIL não definido; ninguém terá acesso ao painel de ADM.');

types.setTypeParser(20, Number);   // bigint  -> número (timestamps e COUNT)
types.setTypeParser(1700, Number); // numeric -> número (SUM)
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });

// atalhos: troca ? por $1,$2... e devolve linhas
const n$ = s => { let i = 0; return s.replace(/\?/g, () => '$' + (++i)); };
const all = async (s, ...p) => (await pool.query(n$(s), p)).rows;
const get = async (s, ...p) => (await all(s, ...p))[0];
const run = async (s, ...p) => { await pool.query(n$(s), p); };

async function criarTabelas() {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS usuarios(id SERIAL PRIMARY KEY, email TEXT UNIQUE, senha_hash TEXT,
    papel TEXT DEFAULT 'cliente', cpf TEXT, bloqueado INTEGER DEFAULT 0, criado BIGINT);
  CREATE TABLE IF NOT EXISTS lojas(id SERIAL PRIMARY KEY, usuario_id INTEGER UNIQUE, slug TEXT UNIQUE,
    nome TEXT, quem_somos TEXT DEFAULT '', whatsapp TEXT DEFAULT '', pix TEXT DEFAULT '');
  CREATE TABLE IF NOT EXISTS produtos(id SERIAL PRIMARY KEY, loja_id INTEGER, classe TEXT, nome TEXT DEFAULT '',
    tamanho TEXT DEFAULT '', descricao TEXT, preco DOUBLE PRECISION, estoque INTEGER DEFAULT 1, foto TEXT, criado BIGINT);
  CREATE TABLE IF NOT EXISTS cupons(id SERIAL PRIMARY KEY, loja_id INTEGER, codigo TEXT, tipo TEXT, valor DOUBLE PRECISION, ativo INTEGER DEFAULT 1);
  CREATE TABLE IF NOT EXISTS vales(id SERIAL PRIMARY KEY, loja_id INTEGER, codigo TEXT UNIQUE, valor DOUBLE PRECISION, usado INTEGER DEFAULT 0, criado BIGINT);
  CREATE TABLE IF NOT EXISTS avisos(id SERIAL PRIMARY KEY, loja_id INTEGER, tipo TEXT, titulo TEXT, texto TEXT, criado BIGINT);
  CREATE TABLE IF NOT EXISTS pedidos(id SERIAL PRIMARY KEY, loja_id INTEGER, usuario_id INTEGER, ip TEXT, produto_id INTEGER,
    item TEXT, preco_original DOUBLE PRECISION, desconto DOUBLE PRECISION, preco DOUBLE PRECISION, cupom TEXT, metodo TEXT,
    nome TEXT, cep TEXT, cidade TEXT, bairro TEXT, rua TEXT, numero TEXT, telefone TEXT, comprovante TEXT, criado BIGINT);
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS avatar TEXT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS banner TEXT;
  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pendente';
  CREATE TABLE IF NOT EXISTS mensagens(id SERIAL PRIMARY KEY, pedido_id INTEGER, autor_id INTEGER, texto TEXT, criado BIGINT);
  CREATE INDEX IF NOT EXISTS idx_msg_pedido ON mensagens(pedido_id);
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS aceite_politica BIGINT;
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS prefs_notif TEXT;
  ALTER TABLE vales ADD COLUMN IF NOT EXISTS saldo DOUBLE PRECISION;
  UPDATE vales SET saldo = CASE WHEN usado=1 THEN 0 ELSE valor END WHERE saldo IS NULL;
  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS estado TEXT;
  ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS loja_id INTEGER;
  ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS cliente_id INTEGER;
  CREATE TABLE IF NOT EXISTS banner_video(id INTEGER PRIMARY KEY, mime TEXT, dados BYTEA, versao BIGINT);
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS mp_access_token TEXT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS mp_refresh_token TEXT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS mp_user_id TEXT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS mp_expira BIGINT;
  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS mp_pagamento TEXT;
  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS taxa_mp DOUBLE PRECISION;
  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS aprovado_em BIGINT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS assin_id TEXT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS assin_status TEXT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS assin_check BIGINT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS acesso_ate BIGINT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS cep_origem TEXT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS loja_estado TEXT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS loja_cidade TEXT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS loja_bairro TEXT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS loja_rua TEXT;
  ALTER TABLE lojas ADD COLUMN IF NOT EXISTS loja_numero TEXT;
  CREATE TABLE IF NOT EXISTS enderecos(id SERIAL PRIMARY KEY, usuario_id INTEGER, apelido TEXT, cep TEXT, estado TEXT, cidade TEXT, bairro TEXT, rua TEXT, numero TEXT, criado BIGINT);
  ALTER TABLE produtos ADD COLUMN IF NOT EXISTS peso_g INTEGER;
  ALTER TABLE produtos ADD COLUMN IF NOT EXISTS comp_cm INTEGER;
  ALTER TABLE produtos ADD COLUMN IF NOT EXISTS larg_cm INTEGER;
  ALTER TABLE produtos ADD COLUMN IF NOT EXISTS alt_cm INTEGER;
  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS frete_servico TEXT;
  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS frete_valor DOUBLE PRECISION;
  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS frete_prazo INTEGER;
  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entrega_etapa TEXT;
  ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS rastreio TEXT;
  CREATE TABLE IF NOT EXISTS notificacoes(id SERIAL PRIMARY KEY, usuario_id INTEGER, tipo TEXT, titulo TEXT, texto TEXT, destino TEXT, criada BIGINT, lida INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS leituras(usuario_id INTEGER, chave TEXT, lida_ate INTEGER, PRIMARY KEY (usuario_id, chave));
  CREATE TABLE IF NOT EXISTS entrega_eventos(id SERIAL PRIMARY KEY, pedido_id INTEGER, etapa TEXT, nota TEXT, criado BIGINT);
  CREATE TABLE IF NOT EXISTS chaves_acesso(id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, dias INTEGER, criada BIGINT, usada_por INTEGER, usada_em BIGINT);`);
}

// ---------- REGRAS ----------
const CLASSES = { roupas: ['tamanho'], calcados: ['tamanho'], bolsas: [], perfumes: ['nome'], cosmeticos: ['nome'], servicos: [] };
const VALES = [10, 30, 50, 70, 100, 200, 250, 300, 400, 500];
const MAX_CUPOM = 50;
const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
const digits = s => String(s || '').replace(/\D/g, '');
const txt = (s, n = 2000) => String(s ?? '').trim().slice(0, n);       // todo texto recebido tem tamanho máximo
const IMG_RE = /^data:image\/(png|jpeg|webp|gif);base64,(iVBOR|\/9j\/|UklGR|R0lGOD)[A-Za-z0-9+/]+={0,2}$/;   // só PNG, JPEG, WebP e GIF reais (nada de SVG nem texto extra)
const ehImagem = (s, max = 1500000) => typeof s === 'string' && s.length <= max && IMG_RE.test(s);
function cpfOk(c) {
  c = digits(c); if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (const k of [9, 10]) { let s = 0; for (let i = 0; i < k; i++) s += c[i] * (k + 1 - i); if (((s * 10) % 11) % 10 !== Number(c[k])) return false; }
  return true;
}
const slugar = s => txt(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'loja';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const EM_PRODUCAO = !!process.env.RENDER || process.env.NODE_ENV === 'production';
if ((process.env.SEGREDO || '').length < 24) console.warn('AVISO DE SEGURANÇA: defina SEGREDO com 24 ou mais caracteres no Render.');

// HTTPS obrigatório (o /api/saude fica de fora para os monitores)
app.use((req, res, next) => {
  if (EM_PRODUCAO && !req.secure && req.path !== '/api/saude')
    return res.redirect(301, (SITE_URL || 'https://' + req.headers.host) + req.originalUrl);
  next();
});
// cabeçalhos de segurança
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin' });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
// limitador de tentativas (fica na memória; zera quando o servidor reinicia)
const janelas = new Map();
function limitar(chave, max, ms) {
  const agora = Date.now(); let j = janelas.get(chave);
  if (!j || agora > j.fim) { j = { n: 0, fim: agora + ms }; janelas.set(chave, j); }
  return ++j.n <= max;
}
setInterval(() => { const agora = Date.now(); for (const [k, j] of janelas) if (agora > j.fim) janelas.delete(k); }, 60000).unref();
const limite = (nome, max, ms, porUsuario = false) => (req, res, next) =>
  limitar(`${nome}:${porUsuario && req.u ? 'u' + req.u.id : req.ip}`, max, ms) ? next() : res.status(429).json({ erro: 'Muitas tentativas. Aguarde um pouco e tente de novo.' });
const senhaForte = s => typeof s === 'string' && s.length >= 8 && s.length <= 72 && /[A-Za-z]/.test(s) && /\d/.test(s);
const DUMMY = bcrypt.hashSync('senha-falsa-para-igualar-o-tempo', 12);
const entrar = (req, uid) => new Promise((ok, no) => req.session.regenerate(e => {   // sessão nova a cada login (evita fixação de sessão)
  if (e) return no(e); req.session.uid = uid; req.session.save(e2 => (e2 ? no(e2) : ok()));
}));
// proteção da API: limite geral, anti-CSRF (cabeçalho próprio + origem) e sem cache
app.use('/api', (req, res, next) => {
  if (req.path === '/mp/webhook' || req.path === '/saude' || req.path.startsWith('/banner/video')) return next();
  return limite('api', 300, 60000)(req, res, next);
});
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/mp/webhook') return next();
  const o = req.headers.origin;
  if (o) { try { if (new URL(o).host !== req.headers.host) return res.status(403).json({ erro: 'Origem não permitida.' }); } catch (e) { return res.status(403).json({ erro: 'Origem inválida.' }); } }
  if (req.headers['x-kivra'] !== '1') return res.status(403).json({ erro: 'Requisição não permitida.' });
  next();
});
app.use('/api', (req, res, next) => { if (!req.path.startsWith('/banner/video')) res.set('Cache-Control', 'no-store'); next(); });
process.on('unhandledRejection', e => console.error('Promessa rejeitada:', e));
app.use('/api', session({
  store: new PgSession({ pool, createTableIfMissing: true }), // login guardado no Supabase
  name: 'kivra.sid', secret: process.env.SEGREDO || 'troque-este-segredo', resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 14 * 24 * 3600 * 1000 },
}));
app.use('/api', async (req, res, next) => {
  req.u = req.session.uid ? await get('SELECT * FROM usuarios WHERE id=?', req.session.uid) : null;
  if (req.u && req.u.bloqueado) { req.u = null; req.session.uid = null; }
  next();
});
app.use('/api/admin/banner-video',   // só o ADM pode mandar um corpo grande (vídeo), e a checagem vem antes de ler o corpo
  (req, res, next) => (req.u && req.u.papel === 'admin' && req.u.email === ADMIN_EMAIL ? next() : res.status(403).json({ erro: 'Acesso negado.' })),
  express.json({ limit: '20mb' }));
app.use(express.json({ limit: '4mb' }));
const logado = (req, res, next) => req.u ? next() : res.status(401).json({ erro: 'Entre na sua conta.' });
const vendedor = async (req, res, next) => {
  if (!req.u || req.u.papel !== 'vendedor') return res.status(403).json({ erro: 'Apenas vendedores.' });
  req.loja = await get('SELECT id,usuario_id,slug,nome,quem_somos,whatsapp,pix,cep_origem,loja_estado,loja_cidade,loja_bairro,loja_rua,loja_numero,(mp_access_token IS NOT NULL) AS mp_conectado FROM lojas WHERE usuario_id=?', req.u.id); next();
};
const admin = (req, res, next) =>
  req.u && req.u.papel === 'admin' && req.u.email === ADMIN_EMAIL ? next() : res.status(403).json({ erro: 'Acesso negado.' });

// ---------- CONTA ----------
app.post('/api/cadastro', limite('cad', 8, 3600000), async (req, res) => {
  const { senha, confirmar, cpf, nomeLoja } = req.body;
  const email = txt(req.body.email, 200).toLowerCase();
  const tipo = req.body.tipo === 'vendedor' ? 'vendedor' : 'cliente';
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
  if (!senhaForte(senha)) return res.status(400).json({ erro: 'A senha precisa ter de 8 a 72 caracteres, com letras e números.' });
  if (senha !== confirmar) return res.status(400).json({ erro: 'As senhas não são iguais.' });
  if (!req.body.aceite) return res.status(400).json({ erro: 'Aceite a Política de Privacidade para criar a conta.' });
  if (await get('SELECT 1 AS x FROM usuarios WHERE email=?', email)) return res.status(400).json({ erro: 'E-mail já cadastrado.' });
  if (tipo === 'vendedor' && (!cpfOk(cpf) || !txt(nomeLoja))) return res.status(400).json({ erro: 'Vendedor precisa de CPF válido e nome da loja.' });
  const papel = email === ADMIN_EMAIL ? 'admin' : tipo;
  const u = await get('INSERT INTO usuarios(email,senha_hash,papel,cpf,criado,aceite_politica) VALUES(?,?,?,?,?,?) RETURNING id',
    email, await bcrypt.hash(senha, 12), papel, tipo === 'vendedor' ? cifrar(digits(cpf)) : null, Date.now(), Date.now());
  if (tipo === 'vendedor') {
    let slug = slugar(nomeLoja); if (await get('SELECT 1 AS x FROM lojas WHERE slug=?', slug)) slug += '-' + crypto.randomBytes(2).toString('hex');
    await run('INSERT INTO lojas(usuario_id,slug,nome) VALUES(?,?,?)', u.id, slug, txt(nomeLoja));
  }
  await entrar(req, u.id); res.json({ ok: true });
});
app.post('/api/login', limite('login', 15, 15 * 60000), async (req, res) => {
  const email = txt(req.body.email, 200).toLowerCase();
  if (!limitar('login-e:' + email, 8, 15 * 60000)) return res.status(429).json({ erro: 'Muitas tentativas para este e-mail. Aguarde alguns minutos.' });
  const u = await get('SELECT * FROM usuarios WHERE email=?', email);
  const ok = await bcrypt.compare(String(req.body.senha || '').slice(0, 100), u ? u.senha_hash : DUMMY);   // leva o mesmo tempo com e-mail inexistente
  if (!u || !ok) return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  if (u.bloqueado) return res.status(403).json({ erro: 'Conta bloqueada. Fale com o administrador.' });
  await entrar(req, u.id); res.json({ ok: true });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => { res.clearCookie('kivra.sid'); res.json({ ok: true }); }));
app.get('/api/eu', async (req, res) => {
  if (!req.u) return res.json({ logado: false });
  const loja = req.u.papel === 'vendedor' ? await get('SELECT id,usuario_id,slug,nome,quem_somos,whatsapp,pix,cep_origem,loja_estado,loja_cidade,loja_bairro,loja_rua,loja_numero,(mp_access_token IS NOT NULL) AS mp_conectado FROM lojas WHERE usuario_id=?', req.u.id) : null;
  res.json({ logado: true, email: req.u.email, papel: req.u.papel, loja, mp_pronto: mpPronto() });
});

// ---------- VITRINE PÚBLICA ----------
app.get('/api/produtos', async (req, res) => {
  const { q, classe, min, max, loja } = req.query;
  let sql = `SELECT p.*, l.nome AS loja_nome, l.slug FROM produtos p JOIN lojas l ON l.id=p.loja_id
             JOIN usuarios u ON u.id=l.usuario_id WHERE u.bloqueado=0 AND p.estoque>0`; const a = [];
  if (txt(q)) { sql += ' AND (p.nome ILIKE ? OR p.descricao ILIKE ?)'; a.push(`%${txt(q)}%`, `%${txt(q)}%`); }
  if (classe) { sql += ' AND p.classe=?'; a.push(classe); }
  if (min !== undefined && min !== '') { sql += ' AND p.preco>=?'; a.push(Number(min)); }
  if (max !== undefined && max !== '') { sql += ' AND p.preco<=?'; a.push(Number(max)); }
  if (loja) { sql += ' AND l.slug=?'; a.push(loja); }
  res.json(await all(sql + ' ORDER BY p.criado DESC LIMIT 300', ...a));
});
// Loja que mais vendeu na semana (pedidos aprovados nos últimos 7 dias); sem vendas na semana, a que mais vendeu no total
app.get('/api/lojas/destaque', async (req, res) => {
  const base = filtro => `SELECT l.nome,l.slug,l.avatar,COUNT(p.id) AS vendas,COALESCE(SUM(p.preco),0) AS total
    FROM pedidos p JOIN lojas l ON l.id=p.loja_id JOIN usuarios u ON u.id=l.usuario_id
    WHERE p.status='aprovado' AND u.bloqueado=0 ${filtro}
    GROUP BY l.id,l.nome,l.slug,l.avatar ORDER BY vendas DESC,total DESC LIMIT 1`;
  let r = await get(base('AND COALESCE(p.aprovado_em,p.criado) > ?'), Date.now() - 7 * 24 * 3600 * 1000);
  if (r) return res.json({ ...r, semana: true });
  r = await get(base(''));
  res.json(r ? { ...r, semana: false } : {});
});
app.get('/api/lojas/:slug', async (req, res) => {
  const l = await get(`SELECT l.id,l.nome,l.slug,l.quem_somos,l.whatsapp,l.avatar,l.banner,l.loja_cidade,l.loja_estado FROM lojas l JOIN usuarios u ON u.id=l.usuario_id
                       WHERE l.slug=? AND u.bloqueado=0`, req.params.slug);
  if (!l) return res.status(404).json({ erro: 'Loja não encontrada.' });
  const faixa = await get('SELECT MIN(preco) AS min, MAX(preco) AS max FROM produtos WHERE loja_id=? AND estoque>0', l.id);
  res.json({ ...l, faixa_preco: faixa, vales: VALES });
});
app.get('/api/lojas', async (req, res) => res.json(await all(
  `SELECT l.nome,l.slug FROM lojas l JOIN usuarios u ON u.id=l.usuario_id WHERE u.bloqueado=0 ORDER BY l.nome`)));
app.get('/api/inicio', async (req, res) => res.json(await all(
  `SELECT a.tipo,a.titulo,a.texto,a.criado,l.nome AS loja_nome,l.slug FROM avisos a JOIN lojas l ON l.id=a.loja_id
   JOIN usuarios u ON u.id=l.usuario_id WHERE u.bloqueado=0 ORDER BY a.criado DESC LIMIT 30`)));

// ---------- VENDEDOR ----------
app.put('/api/vendedor/loja', vendedor, async (req, res) => {
  const w = digits(req.body.whatsapp);
  if (!txt(req.body.nome)) return res.status(400).json({ erro: 'Informe o nome da loja.' });
  if (w && w.length < 10) return res.status(400).json({ erro: 'WhatsApp inválido.' });
  await run('UPDATE lojas SET nome=?, quem_somos=?, whatsapp=?, pix=? WHERE id=?', txt(req.body.nome), txt(req.body.quem_somos), w, txt(req.body.pix), req.loja.id);
  // endereço da loja: se preencher algum campo, precisa preencher todos (o CEP também serve de origem do frete)
  const E = { cep: digits(req.body.cep_origem), uf: txt(req.body.loja_estado), ci: txt(req.body.loja_cidade), ba: txt(req.body.loja_bairro), ru: txt(req.body.loja_rua), nu: txt(req.body.loja_numero) };
  if (E.cep || E.uf || E.ci || E.ba || E.ru || E.nu) {
    if (E.cep.length !== 8 || !UFS.includes(E.uf) || !E.ci || !E.ba || !E.ru || !E.nu)
      return res.status(400).json({ erro: 'Preencha o endereço completo da loja: CEP, estado, cidade, bairro, rua e número.' });
    await run('UPDATE lojas SET cep_origem=?, loja_estado=?, loja_cidade=?, loja_bairro=?, loja_rua=?, loja_numero=? WHERE id=?', E.cep, E.uf, E.ci, E.ba, E.ru, E.nu, req.loja.id);
  }
  if (ehImagem(req.body.avatar)) await run('UPDATE lojas SET avatar=? WHERE id=?', req.body.avatar, req.loja.id);
  if (ehImagem(req.body.banner)) await run('UPDATE lojas SET banner=? WHERE id=?', req.body.banner, req.loja.id);
  res.json({ ok: true });
});
app.get('/api/vendedor/produtos', vendedor, async (req, res) => res.json(await all('SELECT * FROM produtos WHERE loja_id=? ORDER BY criado DESC', req.loja.id)));
app.post('/api/vendedor/produtos', vendedor, async (req, res) => {
  const { classe, nome, tamanho, descricao, preco, foto, estoque } = req.body;
  if (!CLASSES[classe]) return res.status(400).json({ erro: 'Classe inválida.' });
  const L = req.loja;                // a loja precisa ter endereço antes de cadastrar produtos
  if (!(L.cep_origem && L.loja_estado && L.loja_cidade && L.loja_bairro && L.loja_rua && L.loja_numero))
    return res.status(400).json({ erro: 'Preencha o endereço da loja em Minha loja → Loja antes de cadastrar produtos.' });
  if ((await get('SELECT COUNT(*) AS n FROM produtos WHERE loja_id=?', L.id)).n >= 500) return res.status(400).json({ erro: 'Limite de 500 produtos por loja.' });
  const d = { nome: txt(nome), tamanho: txt(tamanho) };
  for (const c of CLASSES[classe]) if (!d[c]) return res.status(400).json({ erro: `Informe o campo: ${c}.` });
  if (!txt(descricao)) return res.status(400).json({ erro: 'Informe a descrição.' });
  if (!(Number(preco) > 0)) return res.status(400).json({ erro: 'Preço inválido.' });
  if (classe !== 'servicos' && !ehImagem(foto)) return res.status(400).json({ erro: 'Adicione a foto.' });
  await run('INSERT INTO produtos(loja_id,classe,nome,tamanho,descricao,preco,estoque,foto,criado,peso_g,comp_cm,larg_cm,alt_cm) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    req.loja.id, classe, d.nome, d.tamanho, txt(descricao), Number(preco), classe === 'servicos' ? 1 : Math.max(1, parseInt(estoque) || 1), ehImagem(foto) ? foto : null, Date.now(),
    ...(classe === 'servicos' ? [null, null, null, null] : [intEntre(req.body.peso_g, 1, 30000), intEntre(req.body.comp_cm, 1, 100), intEntre(req.body.larg_cm, 1, 100), intEntre(req.body.alt_cm, 1, 100)]));
  res.json({ ok: true });
});
app.put('/api/vendedor/produtos/:id/estoque', vendedor, async (req, res) => {
  const est = parseInt(req.body.estoque); if (!(est >= 0)) return res.status(400).json({ erro: 'Estoque inválido.' });
  await run('UPDATE produtos SET estoque=? WHERE id=? AND loja_id=?', est, req.params.id, req.loja.id); res.json({ ok: true });
});
app.delete('/api/vendedor/produtos/:id', vendedor, async (req, res) => { await run('DELETE FROM produtos WHERE id=? AND loja_id=?', req.params.id, req.loja.id); res.json({ ok: true }); });

app.get('/api/vendedor/cupons', vendedor, async (req, res) => res.json(await all('SELECT * FROM cupons WHERE loja_id=?', req.loja.id)));
app.post('/api/vendedor/cupons', vendedor, async (req, res) => {
  const codigo = txt(req.body.codigo).toUpperCase(), tipo = req.body.tipo, valor = Number(req.body.valor);
  if (!/^[A-Z0-9]{3,20}$/.test(codigo)) return res.status(400).json({ erro: 'Código: 3 a 20 letras ou números.' });
  if (!['percentual', 'valor'].includes(tipo) || !(valor > 0)) return res.status(400).json({ erro: 'Valor do cupom inválido.' });
  if (tipo === 'percentual' && valor > MAX_CUPOM) return res.status(400).json({ erro: `Cupons acima de ${MAX_CUPOM}% não podem ser emitidos.` });
  if (await get('SELECT 1 AS x FROM cupons WHERE loja_id=? AND codigo=?', req.loja.id, codigo)) return res.status(400).json({ erro: 'Esse código já existe.' });
  await run('INSERT INTO cupons(loja_id,codigo,tipo,valor) VALUES(?,?,?,?)', req.loja.id, codigo, tipo, valor); res.json({ ok: true });
});
app.delete('/api/vendedor/cupons/:id', vendedor, async (req, res) => { await run('DELETE FROM cupons WHERE id=? AND loja_id=?', req.params.id, req.loja.id); res.json({ ok: true }); });

app.get('/api/vendedor/vales', vendedor, async (req, res) => res.json(await all('SELECT * FROM vales WHERE loja_id=? ORDER BY criado DESC', req.loja.id)));
app.post('/api/vendedor/vales', vendedor, async (req, res) => {
  const valor = Number(req.body.valor);
  if (!VALES.includes(valor)) return res.status(400).json({ erro: 'Valor não disponível para vale presente.' });
  const codigo = 'VP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  await run('INSERT INTO vales(loja_id,codigo,valor,saldo,criado) VALUES(?,?,?,?,?)', req.loja.id, codigo, valor, valor, Date.now());
  res.json({ ok: true, codigo, valor });
});
app.post('/api/vendedor/avisos', vendedor, async (req, res) => {
  const tipo = req.body.tipo === 'estoque' ? 'estoque' : 'promocao';
  if (!txt(req.body.titulo)) return res.status(400).json({ erro: 'Informe o título.' });
  await run('INSERT INTO avisos(loja_id,tipo,titulo,texto,criado) VALUES(?,?,?,?,?)', req.loja.id, tipo, txt(req.body.titulo), txt(req.body.texto), Date.now());
  res.json({ ok: true });
});
app.get('/api/vendedor/pedidos', vendedor, async (req, res) =>
  res.json(await all(`SELECT * FROM pedidos WHERE loja_id=? ORDER BY criado ${req.query.ordem === 'antigos' ? 'ASC' : 'DESC'} LIMIT 300`, req.loja.id)));

async function relatorio(lojaId) {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth();
  const ini = { mes: new Date(y, m, 1), bimestre: new Date(y, Math.floor(m / 2) * 2, 1),
                trimestre: new Date(y, Math.floor(m / 3) * 3, 1), ano: new Date(y, 0, 1) };
  const out = {};
  for (const [k, t] of Object.entries(ini)) {
    const r = lojaId
      ? await get('SELECT COUNT(*) AS n, COALESCE(SUM(preco),0) AS total FROM pedidos WHERE status=\'aprovado\' AND loja_id=? AND criado>=?', lojaId, +t)
      : await get('SELECT COUNT(*) AS n, COALESCE(SUM(preco),0) AS total FROM pedidos WHERE status=\'aprovado\' AND criado>=?', +t);
    out[k] = { vendas: r.n, total: r.total };
  }
  return out;
}
app.get('/api/vendedor/relatorio', vendedor, async (req, res) => res.json(await relatorio(req.loja.id)));

// ---------- PEDIDOS ----------
app.post('/api/pedidos', logado, limite('pedido', 30, 3600000, true), async (req, res) => {
  const b = req.body; let loja_id, item, preco, produto_id = null;
  if (b.vale_valor) {
    const l = await get('SELECT id FROM lojas WHERE id=?', b.loja_id);
    if (!l || !VALES.includes(Number(b.vale_valor))) return res.status(400).json({ erro: 'Vale inválido.' });
    loja_id = l.id; item = `Vale presente R$ ${Number(b.vale_valor)}`; preco = Number(b.vale_valor);
  } else {
    const p = await get('SELECT p.*, u.bloqueado FROM produtos p JOIN lojas l ON l.id=p.loja_id JOIN usuarios u ON u.id=l.usuario_id WHERE p.id=?', b.produto_id ?? null);
    if (!p || p.bloqueado) return res.status(404).json({ erro: 'Produto não encontrado.' });
    if (p.estoque < 1) return res.status(400).json({ erro: 'Produto sem estoque.' });
    if (p.classe === 'servicos') return res.status(400).json({ erro: 'Serviços são combinados pelo chat da loja.' });
    loja_id = p.loja_id; produto_id = p.id; item = p.nome || p.classe; preco = p.preco;
  }
  const ehVale = !produto_id;   // vale presente não tem entrega, então não pede endereço
  if (!txt(b.nome)) return res.status(400).json({ erro: 'Informe o seu nome.' });
  if (!ehVale) {
    if (!UFS.includes(b.estado)) return res.status(400).json({ erro: 'Escolha o estado.' });
    if (!txt(b.cidade) || !txt(b.bairro) || !txt(b.rua) || !txt(b.numero)) return res.status(400).json({ erro: 'Preencha todos os campos do endereço.' });
    if (digits(b.cep).length !== 8) return res.status(400).json({ erro: 'CEP inválido.' });
  }
  if (digits(b.telefone).length < 10) return res.status(400).json({ erro: 'Telefone inválido (DDD + número).' });
  if (!['pix', 'credito', 'debito'].includes(b.metodo)) return res.status(400).json({ erro: 'Forma de pagamento inválida.' });

  if ((txt(b.cupom) || txt(b.vale_codigo)) && !limitar('cod:' + req.u.id, 20, 3600000)) return res.status(429).json({ erro: 'Muitas tentativas com códigos. Aguarde um pouco.' });
  let desconto = 0, cupom = null;
  if (txt(b.cupom) && produto_id) {
    const c = await get('SELECT * FROM cupons WHERE loja_id=? AND codigo=? AND ativo=1', loja_id, txt(b.cupom).toUpperCase());
    if (!c) return res.status(400).json({ erro: 'Cupom inválido.' });
    desconto = Math.min(c.tipo === 'percentual' ? preco * c.valor / 100 : c.valor, preco * MAX_CUPOM / 100); cupom = c.codigo;
  }
  let vale = null, valeUsado = 0;
  if (txt(b.vale_codigo) && produto_id) {
    vale = await get('SELECT * FROM vales WHERE loja_id=? AND codigo=? AND usado=0', loja_id, txt(b.vale_codigo).toUpperCase());
    if (!vale) return res.status(400).json({ erro: 'Vale presente inválido ou já usado.' });
    valeUsado = Math.min(vale.saldo ?? vale.valor, preco - desconto);
    desconto += valeUsado;
  }
  let frete = null;                 // frete dos Correios: o servidor refaz a cotação e usa o preço dele, nunca o que veio do navegador
  if (!ehVale) {
    const pf = await get('SELECT p.*, l.cep_origem FROM produtos p JOIN lojas l ON l.id=p.loja_id WHERE p.id=?', produto_id);
    if (pf.classe !== 'servicos' && pf.cep_origem && process.env.MELHOR_ENVIO_TOKEN) {
      if (!b.frete_id) return res.status(400).json({ erro: 'Escolha uma opção de frete.' });
      let ops; try { ops = await cotarFrete(pf, digits(b.cep)); } catch (e) { return res.status(e.status || 502).json({ erro: e.message }); }
      frete = ops.find(o => String(o.id) === String(b.frete_id));
      if (!frete) return res.status(400).json({ erro: 'Opção de frete inválida. Calcule o frete de novo.' });
    }
  }
  const final = Math.max(preco - desconto, 0) + (frete ? frete.valor : 0);
  const ped = await get(`INSERT INTO pedidos(loja_id,usuario_id,ip,produto_id,item,preco_original,desconto,preco,cupom,metodo,nome,cep,cidade,bairro,rua,numero,estado,telefone,comprovante,criado,frete_servico,frete_valor,frete_prazo)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    loja_id, req.u.id, req.ip, produto_id, item, preco, desconto, final, cupom, b.metodo, txt(b.nome),
    ehVale ? null : digits(b.cep), ehVale ? null : txt(b.cidade), ehVale ? null : txt(b.bairro), ehVale ? null : txt(b.rua),
    ehVale ? null : txt(b.numero), ehVale ? null : b.estado, digits(b.telefone), null, Date.now(),
    frete ? frete.servico : null, frete ? frete.valor : null, frete ? frete.prazo : null);
  if (produto_id) await run(`UPDATE produtos SET estoque=estoque-1 WHERE id=? AND classe<>'servicos'`, produto_id);
  if (vale) await run('UPDATE vales SET saldo=saldo-?, usado=CASE WHEN saldo-?<=0.001 THEN 1 ELSE 0 END WHERE id=?', valeUsado, valeUsado, vale.id);
  const dono = await get('SELECT usuario_id FROM lojas WHERE id=?', loja_id);
  await notificar(dono && dono.usuario_id, 'pedido', 'Novo pedido', `#${ped.id} · ${item}`, 'vend-ped');
  const l = await get('SELECT whatsapp,pix,(mp_access_token IS NOT NULL) AS mp FROM lojas WHERE id=?', loja_id);
  res.json({ ok: true, id: ped.id, total: final, produto: preco, desconto, frete: frete ? frete.valor : 0, frete_servico: frete ? frete.servico : null, frete_prazo: frete ? frete.prazo : null, whatsapp: l.whatsapp, pix: l.pix, mp: !!l.mp && mpPronto() });
});
app.get('/api/meus-pedidos', logado, async (req, res) =>
  res.json(await all(`SELECT p.id,p.item,p.preco,p.metodo,p.status,p.criado,(p.comprovante IS NOT NULL) AS tem_comp,p.entrega_etapa,p.frete_valor,(p.rua IS NOT NULL) AS tem_end,l.nome AS loja_nome,(l.mp_access_token IS NOT NULL) AS mp
                      FROM pedidos p LEFT JOIN lojas l ON l.id=p.loja_id WHERE p.usuario_id=? ORDER BY p.criado DESC LIMIT 200`, req.u.id)));

// ---------- COMPROVANTE, APROVAÇÃO E CHAT ----------
async function acessoPedido(req, res) {   // só o comprador e o vendedor da loja enxergam o pedido
  const p = await get('SELECT * FROM pedidos WHERE id=?', req.params.id);
  if (p) {
    if (req.u.id === p.usuario_id) return p;
    if (req.u.papel === 'vendedor') {
      const l = await get('SELECT id FROM lojas WHERE usuario_id=?', req.u.id);
      if (l && l.id === p.loja_id) return p;
    }
  }
  res.status(404).json({ erro: 'Pedido não encontrado.' }); return null;
}
app.put('/api/pedidos/:id/comprovante', logado, async (req, res) => {
  const p = await get('SELECT * FROM pedidos WHERE id=? AND usuario_id=?', req.params.id, req.u.id);
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  if (p.status !== 'pendente') return res.status(400).json({ erro: 'Este pedido já foi decidido pelo vendedor.' });
  if (!ehImagem(req.body.comprovante)) return res.status(400).json({ erro: 'Anexe a foto do comprovante.' });
  await run('UPDATE pedidos SET comprovante=? WHERE id=?', req.body.comprovante, p.id);
  await run('INSERT INTO mensagens(pedido_id,autor_id,texto,criado) VALUES(?,?,?,?)', p.id, req.u.id, '📎 Enviei o comprovante do Pix.', Date.now());
  res.json({ ok: true });
});
app.get('/api/pedidos/:id/mensagens', logado, async (req, res) => {
  const p = await acessoPedido(req, res); if (!p) return;
  const m = await all('SELECT id,autor_id,texto,criado FROM mensagens WHERE pedido_id=? ORDER BY id', p.id);
  if (m.length) await marcarLida(req.u.id, `p:${p.id}`, m[m.length - 1].id);
  res.json({ mensagens: m.map(x => ({ id: x.id, texto: x.texto, criado: x.criado, minha: x.autor_id === req.u.id })) });
});
app.post('/api/pedidos/:id/mensagens', logado, limite('msg', 60, 60000, true), async (req, res) => {
  const p = await acessoPedido(req, res); if (!p) return;
  const texto = txt(req.body.texto).slice(0, 1000);
  if (!texto) return res.status(400).json({ erro: 'Escreva uma mensagem.' });
  await run('INSERT INTO mensagens(pedido_id,autor_id,texto,criado) VALUES(?,?,?,?)', p.id, req.u.id, texto, Date.now());
  res.json({ ok: true });
});
app.post('/api/vendedor/pedidos/:id/status', vendedor, async (req, res) => {
  const p = await get('SELECT * FROM pedidos WHERE id=? AND loja_id=?', req.params.id, req.loja.id);
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  if (p.status !== 'pendente') return res.status(400).json({ erro: 'Este pedido já foi decidido.' });
  const st = req.body.status;
  if (!['aprovado', 'recusado'].includes(st)) return res.status(400).json({ erro: 'Status inválido.' });
  await run('UPDATE pedidos SET status=?, aprovado_em=? WHERE id=?', st, Date.now(), p.id);
  await notificar(p.usuario_id, 'pedido', st === 'aprovado' ? 'Pedido aprovado ✅' : 'Pedido recusado ❌', `#${p.id} · ${p.item}`, 'meus');
  let msg = st === 'aprovado' ? 'Pedido aprovado ✅' : 'Pedido recusado ❌. Se tiver dúvidas, fale comigo por aqui.';
  if (st === 'recusado' && p.produto_id) await run(`UPDATE produtos SET estoque=estoque+1 WHERE id=? AND classe<>'servicos'`, p.produto_id);
  if (st === 'aprovado' && !p.produto_id) {       // vale presente: gera o código na aprovação
    const codigo = 'VP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    await run('INSERT INTO vales(loja_id,codigo,valor,saldo,criado) VALUES(?,?,?,?,?)', req.loja.id, codigo, p.preco_original, p.preco_original, Date.now());
    msg += ` Código do seu vale presente: ${codigo}`;
  }
  await run('INSERT INTO mensagens(pedido_id,autor_id,texto,criado) VALUES(?,?,?,?)', p.id, req.u.id, msg, Date.now());
  res.json({ ok: true });
});

// ---------- PAINEL ADM ----------
app.get('/api/admin/usuarios', admin, async (req, res) =>
  res.json(await all('SELECT u.id,u.email,u.papel,u.bloqueado,u.criado,l.nome AS loja FROM usuarios u LEFT JOIN lojas l ON l.usuario_id=u.id ORDER BY u.criado DESC')));
app.post('/api/admin/usuarios/:id/bloqueio', admin, async (req, res) => {
  const u = await get('SELECT * FROM usuarios WHERE id=?', req.params.id);
  if (!u || u.papel === 'admin') return res.status(400).json({ erro: 'Não é possível alterar este usuário.' });
  await run('UPDATE usuarios SET bloqueado=? WHERE id=?', req.body.bloqueado ? 1 : 0, u.id); res.json({ ok: true });
});
app.delete('/api/admin/usuarios/:id', admin, async (req, res) => {
  const u = await get('SELECT * FROM usuarios WHERE id=?', req.params.id);
  if (!u || u.papel === 'admin') return res.status(400).json({ erro: 'Não é possível excluir este usuário.' });
  const l = await get('SELECT id FROM lojas WHERE usuario_id=?', u.id);
  if (l) for (const t of ['produtos', 'cupons', 'vales', 'avisos', 'pedidos']) await run(`DELETE FROM ${t} WHERE loja_id=?`, l.id);
  await run('DELETE FROM lojas WHERE usuario_id=?', u.id);
  await run('DELETE FROM enderecos WHERE usuario_id=?', u.id);
  await run('DELETE FROM notificacoes WHERE usuario_id=?', u.id);
  await run('DELETE FROM leituras WHERE usuario_id=?', u.id);
  await run('UPDATE pedidos SET usuario_id=NULL WHERE usuario_id=?', u.id);
  await run('DELETE FROM usuarios WHERE id=?', u.id); res.json({ ok: true });
});
app.get('/api/admin/relatorio', admin, async (req, res) => res.json(await relatorio(null)));

// ---------- CHAT COM A LOJA (antes de comprar) ----------
const msgsLoja = async (req, res, lojaId, clienteId) => {
  const m = await all('SELECT id,autor_id,texto,criado FROM mensagens WHERE loja_id=? AND cliente_id=? AND pedido_id IS NULL ORDER BY id', lojaId, clienteId);
  if (m.length) await marcarLida(req.u.id, `l:${lojaId}:${clienteId}`, m[m.length - 1].id);
  res.json({ mensagens: m.map(x => ({ id: x.id, texto: x.texto, criado: x.criado, minha: x.autor_id === req.u.id })) });
};
const enviaLoja = async (req, res, lojaId, clienteId) => {
  const texto = txt(req.body.texto).slice(0, 1000);
  if (!texto) return res.status(400).json({ erro: 'Escreva uma mensagem.' });
  await run('INSERT INTO mensagens(pedido_id,autor_id,texto,criado,loja_id,cliente_id) VALUES(NULL,?,?,?,?,?)', req.u.id, texto, Date.now(), lojaId, clienteId);
  res.json({ ok: true });
};
app.get('/api/lojas/:id/mensagens', logado, async (req, res) => msgsLoja(req, res, Number(req.params.id), req.u.id));
app.post('/api/lojas/:id/mensagens', logado, limite('msg', 60, 60000, true), async (req, res) => {
  if (!(await get('SELECT 1 AS x FROM lojas WHERE id=?', req.params.id))) return res.status(404).json({ erro: 'Loja não encontrada.' });
  await enviaLoja(req, res, Number(req.params.id), req.u.id);
});
app.get('/api/vendedor/conversas', vendedor, async (req, res) => res.json(await all(
  `SELECT m.cliente_id, u.email, MAX(m.criado) AS ultima FROM mensagens m JOIN usuarios u ON u.id=m.cliente_id
   WHERE m.loja_id=? AND m.pedido_id IS NULL GROUP BY m.cliente_id, u.email ORDER BY ultima DESC`, req.loja.id)));
app.get('/api/vendedor/conversas/:cid/mensagens', vendedor, async (req, res) => msgsLoja(req, res, req.loja.id, Number(req.params.cid)));
app.post('/api/vendedor/conversas/:cid/mensagens', vendedor, limite('msg', 60, 60000, true), async (req, res) => enviaLoja(req, res, req.loja.id, Number(req.params.cid)));

// ---------- VÍDEO DO BANNER INICIAL (só o ADM envia) ----------
app.get('/api/banner/info', async (req, res) => {
  const v = await get('SELECT versao FROM banner_video WHERE id=1');
  res.json({ video: !!v, versao: v ? v.versao : 0 });
});
app.get('/api/banner/video', async (req, res) => {
  const v = await get('SELECT mime,dados FROM banner_video WHERE id=1');
  if (!v) return res.status(404).end();
  const buf = v.dados, total = buf.length, r = req.headers.range;
  res.set({ 'Content-Type': v.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' });
  if (r) {                                   // iPhone/Safari só toca vídeo com suporte a "Range"
    const m = /bytes=(\d*)-(\d*)/.exec(r) || [];
    let a = m[1] ? parseInt(m[1]) : 0, b = m[2] ? parseInt(m[2]) : total - 1;
    if (!m[1] && m[2]) { a = total - parseInt(m[2]); b = total - 1; }
    b = Math.min(b, total - 1);
    if (!(a >= 0) || a > b) return res.status(416).set('Content-Range', `bytes */${total}`).end();
    res.status(206).set({ 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
    return res.end(buf.subarray(a, b + 1));
  }
  res.set('Content-Length', total); res.end(buf);
});
app.post('/api/admin/banner-video', admin, async (req, res) => {
  const v = String(req.body.video || ''), i = v.indexOf(';base64,'), mime = v.slice(5, i);
  if (!v.startsWith('data:video/') || i < 0 || !['video/mp4', 'video/webm'].includes(mime)) return res.status(400).json({ erro: 'Envie um vídeo MP4 ou WebM.' });
  const dados = Buffer.from(v.slice(i + 8), 'base64');
  if (dados.length > 12 * 1024 * 1024) return res.status(400).json({ erro: 'Vídeo grande demais (máximo 12 MB). Use um vídeo curto.' });
  await run('INSERT INTO banner_video(id,mime,dados,versao) VALUES(1,?,?,?) ON CONFLICT (id) DO UPDATE SET mime=EXCLUDED.mime, dados=EXCLUDED.dados, versao=EXCLUDED.versao', mime, dados, Date.now());
  res.json({ ok: true });
});
app.delete('/api/admin/banner-video', admin, async (req, res) => { await run('DELETE FROM banner_video WHERE id=1'); res.json({ ok: true }); });

// ---------- MERCADO PAGO (cada vendedor conecta a própria conta) ----------
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const MP_ID = process.env.MP_CLIENT_ID, MP_SECRET = process.env.MP_CLIENT_SECRET;
const TAXA_SEM_ASSINATURA = Math.min(Math.max(Number(process.env.TAXA_SEM_ASSINATURA ?? 10), 0), 50);   // % cobrada de quem não assina
const ASSIN_VALOR = Number(process.env.ASSIN_VALOR) > 0 ? Number(process.env.ASSIN_VALOR) : 24.9;                                                                                     // assinatura mensal (R$)
const mpPronto = () => !!(MP_ID && MP_SECRET && SITE_URL);
const CHAVE = crypto.createHash('sha256').update(process.env.SEGREDO || 'troque-este-segredo').digest();
const cifrar = t => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', CHAVE, iv);
  const e = Buffer.concat([c.update(String(t), 'utf8'), c.final()]); return [iv, c.getAuthTag(), e].map(b => b.toString('base64')).join('.'); };
const decifrar = t => { const [iv, tag, e] = String(t).split('.').map(x => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', CHAVE, iv); d.setAuthTag(tag); return Buffer.concat([d.update(e), d.final()]).toString('utf8'); };
async function mpToken(params) {
  const r = await fetch('https://api.mercadopago.com/oauth/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: MP_ID, client_secret: MP_SECRET, ...params }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Mercado Pago recusou a autorização (' + r.status + ')');
  return j;
}
const salvarTokens = (lojaId, j) => run('UPDATE lojas SET mp_access_token=?, mp_refresh_token=?, mp_user_id=?, mp_expira=? WHERE id=?',
  cifrar(j.access_token), j.refresh_token ? cifrar(j.refresh_token) : null, String(j.user_id || ''), Date.now() + (j.expires_in || 15552000) * 1000, lojaId);
async function tokenLoja(lojaId) {            // devolve o token do vendedor, renovando quando está perto de vencer
  const l = await get('SELECT id,mp_access_token,mp_refresh_token,mp_expira FROM lojas WHERE id=?', lojaId);
  if (!l || !l.mp_access_token) return null;
  try {
    if (l.mp_expira && l.mp_refresh_token && Date.now() > l.mp_expira - 7 * 24 * 3600 * 1000) {
      const j = await mpToken({ grant_type: 'refresh_token', refresh_token: decifrar(l.mp_refresh_token) });
      await salvarTokens(l.id, j); return j.access_token;
    }
    return decifrar(l.mp_access_token);
  } catch (e) { console.error('Token Mercado Pago:', e.message); return null; }
}
app.get('/api/vendedor/mp/conectar', vendedor, async (req, res) => {
  if (!mpPronto()) return res.status(400).json({ erro: 'O Mercado Pago ainda não foi configurado pelo administrador do site.' });
  const state = crypto.randomBytes(16).toString('hex');
  req.session.mpState = state;
  const url = `https://auth.mercadopago.com.br/authorization?client_id=${MP_ID}&response_type=code&platform_id=mp&state=${state}&redirect_uri=${encodeURIComponent(SITE_URL + '/api/mp/callback')}`;
  req.session.save(() => res.json({ url }));
});
app.get('/api/mp/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!req.u || req.u.papel !== 'vendedor' || !code || !state || state !== req.session.mpState) return res.redirect('/?mp=erro');
  req.session.mpState = null;
  try {
    const loja = await get('SELECT id FROM lojas WHERE usuario_id=?', req.u.id);
    await salvarTokens(loja.id, await mpToken({ grant_type: 'authorization_code', code, redirect_uri: SITE_URL + '/api/mp/callback' }));
    res.redirect('/?mp=ok');
  } catch (e) { console.error('Callback MP:', e.message); res.redirect('/?mp=erro'); }
});
app.post('/api/vendedor/mp/desconectar', vendedor, async (req, res) => {
  await run('UPDATE lojas SET mp_access_token=NULL, mp_refresh_token=NULL, mp_user_id=NULL, mp_expira=NULL WHERE id=?', req.loja.id);
  res.json({ ok: true });
});
app.post('/api/pedidos/:id/pagar-mp', logado, async (req, res) => {
  const p = await get('SELECT * FROM pedidos WHERE id=? AND usuario_id=?', req.params.id, req.u.id);
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  if (p.status !== 'pendente') return res.status(400).json({ erro: 'Este pedido já foi decidido.' });
  if (!(p.preco > 0)) return res.status(400).json({ erro: 'Este pedido não tem valor a pagar. O vendedor vai aprová-lo.' });
  const token = mpPronto() ? await tokenLoja(p.loja_id) : null;
  if (!token) return res.status(400).json({ erro: 'Esta loja ainda não aceita pagamento online. Combine com o vendedor pelo chat.' });
  const corpo = {
    items: [
      { id: String(p.id), title: String(p.item).slice(0, 120), quantity: 1, currency_id: 'BRL', unit_price: Number((p.preco - (p.frete_valor || 0)).toFixed(2)) },
      { id: 'frete', title: `Frete ${p.frete_servico || ''}`.trim().slice(0, 120), quantity: 1, currency_id: 'BRL', unit_price: Number(Number(p.frete_valor || 0).toFixed(2)) },
    ].filter(i => i.unit_price > 0),
    external_reference: String(p.id),
    notification_url: `${SITE_URL}/api/mp/webhook?pedido=${p.id}`,
    back_urls: { success: `${SITE_URL}/?pagamento=ok`, failure: `${SITE_URL}/?pagamento=erro`, pending: `${SITE_URL}/?pagamento=pendente` },
    auto_return: 'approved',
  };
  const taxaPct = (await assinaturaAtiva(p.loja_id)) ? 0 : TAXA_SEM_ASSINATURA;   // assinante não paga taxa
  const taxa = Number((Math.max(p.preco - (p.frete_valor || 0), 0) * taxaPct / 100).toFixed(2));   // a taxa não incide sobre o frete
  if (taxa > 0) corpo.marketplace_fee = taxa;
  const r = await fetch('https://api.mercadopago.com/checkout/preferences', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(corpo) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.init_point) {
    console.error('MP preferência:', r.status, JSON.stringify(j).slice(0, 300));
    return res.status(502).json({ erro: 'Não foi possível abrir o pagamento agora. Tente de novo ou fale com a loja pelo chat.' });
  }
  await run('UPDATE pedidos SET taxa_mp=? WHERE id=?', taxa, p.id);
  res.json({ url: j.init_point });
});
// O Mercado Pago avisa aqui quando o pagamento muda. Não confiamos no aviso: conferimos o pagamento direto na API deles.
app.all('/api/mp/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const pedidoId = Number(req.query.pedido);
    const pagId = req.query['data.id'] || req.query.id || (req.body && req.body.data && req.body.data.id);
    const tipo = req.query.type || req.query.topic || (req.body && req.body.type);
    if (!pedidoId || !pagId || (tipo && tipo !== 'payment')) return;
    const p = await get('SELECT * FROM pedidos WHERE id=?', pedidoId);
    if (!p || p.status !== 'pendente') return;
    const token = await tokenLoja(p.loja_id); if (!token) return;
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(pagId)}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (!r.ok || j.status !== 'approved' || String(j.external_reference) !== String(p.id) || Number(j.transaction_amount) + 0.01 < p.preco) return;
    const metodo = ({ bank_transfer: 'pix', credit_card: 'credito', debit_card: 'debito' })[j.payment_type_id] || p.metodo;
    const ok = await get(`UPDATE pedidos SET status='aprovado', aprovado_em=?, mp_pagamento=?, metodo=? WHERE id=? AND status='pendente' RETURNING id`, Date.now(), String(j.id), metodo, p.id);
    if (!ok) return;                           // já tinha sido aprovado (aviso repetido)
    let msg = 'Pagamento confirmado pelo Mercado Pago ✅ Pedido aprovado.';
    if (!p.produto_id) {
      const codigo = 'VP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
      await run('INSERT INTO vales(loja_id,codigo,valor,saldo,criado) VALUES(?,?,?,?,?)', p.loja_id, codigo, p.preco_original, p.preco_original, Date.now());
      msg += ` Código do seu vale presente: ${codigo}`;
    }
    await run('INSERT INTO mensagens(pedido_id,autor_id,texto,criado) VALUES(?,?,?,?)', p.id, null, msg, Date.now());
    const donoMp = await get('SELECT usuario_id FROM lojas WHERE id=?', p.loja_id);
    await notificar(p.usuario_id, 'pagamento', 'Pagamento confirmado ✅', `#${p.id} · ${p.item}`, 'meus');
    await notificar(donoMp && donoMp.usuario_id, 'pagamento', 'Pagamento recebido ✅', `#${p.id} · ${p.item}`, 'vend-ped');
  } catch (e) { console.error('Webhook MP:', e.message); }
});

// ---------- ASSINATURA DO LOJISTA (R$ 49,90/mês, vai para a conta do dono da plataforma) ----------
const assinPronta = () => !!(process.env.MP_ACCESS_TOKEN && SITE_URL);
const mpDono = (url, metodo = 'GET', corpo) => fetch(`https://api.mercadopago.com${url}`, { method: metodo,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }, body: corpo ? JSON.stringify(corpo) : undefined });
async function atualizarAssinatura(l, forcar = false) {   // confere a situação da assinatura no Mercado Pago (com cache de 10 min)
  if (!l || !l.assin_id || !process.env.MP_ACCESS_TOKEN) return l ? l.assin_status : null;
  if (!forcar && l.assin_check && Date.now() - l.assin_check < 10 * 60 * 1000) return l.assin_status;
  try {
    const r = await mpDono(`/preapproval/${encodeURIComponent(l.assin_id)}`);
    const j = await r.json();
    if (r.ok && j.status) { await run('UPDATE lojas SET assin_status=?, assin_check=? WHERE id=?', j.status, Date.now(), l.id); return j.status; }
  } catch (e) { console.error('Assinatura MP:', e.message); }
  return l.assin_status;
}
const assinaturaAtiva = async lojaId => {      // vale a assinatura do Mercado Pago OU uma chave de acesso ainda dentro do prazo
  const l = await get('SELECT id,assin_id,assin_status,assin_check,acesso_ate FROM lojas WHERE id=?', lojaId);
  if (!l) return false;
  if (Number(l.acesso_ate) > Date.now()) return true;
  return (await atualizarAssinatura(l)) === 'authorized';
};
app.get('/api/vendedor/assinatura', vendedor, async (req, res) => {
  const l = await get('SELECT id,assin_id,assin_status,assin_check,acesso_ate,(mp_access_token IS NOT NULL) AS mp FROM lojas WHERE id=?', req.loja.id);
  const status = await atualizarAssinatura(l, true);
  const lim = Date.now() - 7 * 24 * 3600 * 1000;
  const resumo = await get(`SELECT COUNT(*) AS n, COALESCE(SUM(preco),0) AS bruto, COALESCE(SUM(COALESCE(taxa_mp,0)),0) AS taxa,
      COALESCE(SUM(CASE WHEN COALESCE(aprovado_em,criado) > ? THEN preco-COALESCE(taxa_mp,0) ELSE 0 END),0) AS recente,
      COALESCE(SUM(CASE WHEN COALESCE(aprovado_em,criado) <= ? THEN preco-COALESCE(taxa_mp,0) ELSE 0 END),0) AS antigo
    FROM pedidos WHERE loja_id=? AND status='aprovado' AND mp_pagamento IS NOT NULL`, lim, lim, req.loja.id);
  res.json({ status: status || null, ativa: status === 'authorized', chave_ate: Number(l.acesso_ate) || 0, valor: ASSIN_VALOR, taxa_pct: TAXA_SEM_ASSINATURA, disponivel: assinPronta(), mp: !!l.mp, resumo });
});
app.post('/api/vendedor/assinatura', vendedor, async (req, res) => {
  if (!assinPronta()) return res.status(400).json({ erro: 'A assinatura ainda não foi configurada pelo administrador do site.' });
  const l = await get('SELECT id,assin_id,assin_status,assin_check FROM lojas WHERE id=?', req.loja.id);
  if ((await atualizarAssinatura(l, true)) === 'authorized') return res.status(400).json({ erro: 'Sua assinatura já está ativa.' });
  const emailMp = txt(req.body.email_mp || req.u.email).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(emailMp)) return res.status(400).json({ erro: 'Informe o e-mail da sua conta do Mercado Pago.' });
  const r = await mpDono('/preapproval', 'POST', { reason: 'Assinatura Kivra - plano lojista', external_reference: `loja-${req.loja.id}`, payer_email: emailMp,
    auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: ASSIN_VALOR, currency_id: 'BRL' },
    back_url: `${SITE_URL}/?assinatura=retorno`, status: 'pending' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.init_point) {
    console.error('MP assinatura:', r.status, JSON.stringify(j).slice(0, 300));
    return res.status(502).json({ erro: 'Não foi possível abrir a assinatura agora. Confira o e-mail da conta do Mercado Pago e tente de novo.' });
  }
  await run('UPDATE lojas SET assin_id=?, assin_status=?, assin_check=? WHERE id=?', String(j.id), j.status || 'pending', Date.now(), req.loja.id);
  res.json({ url: j.init_point });
});
app.post('/api/vendedor/assinatura/cancelar', vendedor, async (req, res) => {
  const l = await get('SELECT id,assin_id FROM lojas WHERE id=?', req.loja.id);
  if (!l || !l.assin_id) return res.status(400).json({ erro: 'Você não tem assinatura.' });
  const r = await mpDono(`/preapproval/${encodeURIComponent(l.assin_id)}`, 'PUT', { status: 'cancelled' });
  if (!r.ok) return res.status(502).json({ erro: 'Não foi possível cancelar agora. Tente de novo.' });
  await run('UPDATE lojas SET assin_status=?, assin_check=? WHERE id=?', 'cancelled', Date.now(), l.id);
  res.json({ ok: true });
});

// ---------- STATUS DO MERCADO PAGO (só o ADM) ----------
app.get('/api/admin/mp/status', admin, async (req, res) => {
  const cfg = { site_url: !!SITE_URL, client_id: !!MP_ID, client_secret: !!MP_SECRET, access_token: !!process.env.MP_ACCESS_TOKEN, frete_token: !!process.env.MELHOR_ENVIO_TOKEN };
  let conta = null, erro = null;
  if (req.query.testar) {
    if (!cfg.access_token) erro = 'Falta a variável MP_ACCESS_TOKEN no Render.';
    else {
      try {
        const r = await mpDono('/users/me'), j = await r.json();
        if (r.ok) conta = { id: j.id, apelido: j.nickname, email: j.email };
        else erro = `O Mercado Pago recusou o Access Token (código ${r.status}). Confira se é o de produção e se foi colado sem espaços.`;
      } catch (e) { erro = 'Não foi possível falar com o Mercado Pago agora.'; }
    }
  }
  const c = await get(`SELECT COUNT(*) FILTER (WHERE mp_access_token IS NOT NULL) AS lojas, COUNT(*) FILTER (WHERE assin_status='authorized') AS assinantes FROM lojas`);
  res.json({ cfg, conta, erro, redirect_url: SITE_URL ? SITE_URL + '/api/mp/callback' : null, taxa_pct: TAXA_SEM_ASSINATURA, lojas: c.lojas, assinantes: c.assinantes });
});

// ---------- CHAVES DE ACESSO (o ADM gera, o lojista ativa) ----------
const ALFA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sem letras que se confundem (0/O, 1/I)
const novaChave = () => 'KIV-' + [0, 1, 2].map(() => Array.from(crypto.randomBytes(4), b => ALFA[b % 32]).join('')).join('-');
app.post('/api/admin/chaves', admin, async (req, res) => {
  const dias = parseInt(req.body.dias);
  if (!(dias >= 7 && dias <= 30)) return res.status(400).json({ erro: 'Escolha de 7 a 30 dias.' });
  const codigo = novaChave();
  await run('INSERT INTO chaves_acesso(codigo,dias,criada) VALUES(?,?,?)', codigo, dias, Date.now());
  res.json({ ok: true, codigo, dias });
});
app.get('/api/admin/chaves', admin, async (req, res) => res.json(await all(
  `SELECT k.id,k.codigo,k.dias,k.criada,k.usada_em,l.nome AS loja FROM chaves_acesso k LEFT JOIN lojas l ON l.id=k.usada_por ORDER BY k.id DESC LIMIT 50`)));
app.delete('/api/admin/chaves/:id', admin, async (req, res) => {
  await run('DELETE FROM chaves_acesso WHERE id=? AND usada_em IS NULL', req.params.id);   // chave já usada não se apaga
  res.json({ ok: true });
});
const tentativasChave = new Map();                  // limite simples contra quem tenta adivinhar chaves
app.post('/api/vendedor/chave', vendedor, async (req, res) => {
  const t = tentativasChave.get(req.u.id) || { n: 0, ate: Date.now() + 3600000 };
  if (Date.now() > t.ate) { t.n = 0; t.ate = Date.now() + 3600000; }
  if (t.n >= 10) return res.status(429).json({ erro: 'Muitas tentativas. Tente de novo mais tarde.' });
  const limpo = txt(req.body.codigo).toUpperCase().replace(/[^A-Z0-9]/g, '');
  // "usar" a chave é uma só operação no banco: se duas pessoas tentarem ao mesmo tempo, só uma consegue
  const k = limpo ? await get(`UPDATE chaves_acesso SET usada_por=?, usada_em=? WHERE REPLACE(codigo,'-','')=? AND usada_em IS NULL RETURNING dias`, req.loja.id, Date.now(), limpo) : null;
  if (!k) { t.n++; tentativasChave.set(req.u.id, t); return res.status(400).json({ erro: 'Chave inválida ou já usada.' }); }
  const l = await get('SELECT acesso_ate FROM lojas WHERE id=?', req.loja.id);
  const ate = Math.max(Date.now(), Number(l.acesso_ate) || 0) + k.dias * 24 * 3600 * 1000;   // soma ao que já tinha
  await run('UPDATE lojas SET acesso_ate=? WHERE id=?', ate, req.loja.id);
  res.json({ ok: true, dias: k.dias, ate });
});

// Endereço leve para monitores de disponibilidade: acorda o servidor e também toca o banco
app.get('/api/saude', async (req, res) => {
  try { await get('SELECT 1 AS ok'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false }); }
});

// ---------- FRETE DOS CORREIOS (cotação via Melhor Envio, sem contrato próprio) ----------
const intEntre = (v, min, max) => { const n = parseInt(v); return n >= min && n <= max ? n : null; };
const PADRAO = {   // embalagem usada quando o vendedor não informa peso e medidas (peso em gramas, medidas em cm)
  roupas: { peso: 300, c: 25, l: 20, a: 5 }, calcados: { peso: 1000, c: 35, l: 25, a: 15 }, bolsas: { peso: 700, c: 35, l: 28, a: 12 },
  perfumes: { peso: 400, c: 20, l: 15, a: 10 }, cosmeticos: { peso: 300, c: 18, l: 12, a: 8 } };
async function cotarFrete(p, cepDestino) {
  const token = process.env.MELHOR_ENVIO_TOKEN;
  if (!token) throw Object.assign(new Error('O cálculo de frete ainda não está disponível. Combine o frete pelo chat.'), { status: 503 });
  const d = PADRAO[p.classe] || PADRAO.roupas;
  const base = process.env.ME_SANDBOX ? 'https://sandbox.melhorenvio.com.br' : 'https://melhorenvio.com.br';
  const r = await fetch(base + '/api/v2/me/shipment/calculate', { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json',
               'User-Agent': `Kivra (${process.env.CONTATO_EMAIL || ADMIN_EMAIL || 'contato@kivra'})` },
    body: JSON.stringify({ from: { postal_code: digits(p.cep_origem) }, to: { postal_code: digits(cepDestino) },
      products: [{ id: String(p.id), weight: (p.peso_g || d.peso) / 1000, length: Math.max(p.comp_cm || d.c, 16), width: Math.max(p.larg_cm || d.l, 11),
                   height: Math.max(p.alt_cm || d.a, 2), insurance_value: Number(p.preco), quantity: 1 }],
      services: '1,2' }) });                                   // 1 = PAC, 2 = SEDEX (Correios)
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) { console.error('Melhor Envio:', r.status, JSON.stringify(j).slice(0, 300)); throw Object.assign(new Error('Não foi possível calcular o frete agora. Tente de novo ou combine pelo chat.'), { status: 502 }); }
  return j.filter(x => !x.error && x.price != null && /correios/i.test((x.company && x.company.name) || ''))
    .map(x => ({ id: x.id, servico: x.name, valor: Number(String(x.custom_price ?? x.price).replace(',', '.')),
                 prazo: x.delivery_time || (x.delivery_range && x.delivery_range.max) || null }))
    .filter(o => o.valor > 0);
}
const freteIp = new Map();                                    // limite simples de consultas por visitante
app.post('/api/frete/cotar', async (req, res) => {
  const agora = Date.now(), t = freteIp.get(req.ip) || { n: 0, ate: agora + 60000 };
  if (agora > t.ate) { t.n = 0; t.ate = agora + 60000; }
  t.n++; freteIp.set(req.ip, t);
  if (t.n > 20) return res.status(429).json({ erro: 'Muitas consultas. Aguarde um minuto.' });
  const cep = digits(req.body.cep);
  if (cep.length !== 8) return res.status(400).json({ erro: 'CEP inválido.' });
  const p = await get('SELECT p.*, l.cep_origem FROM produtos p JOIN lojas l ON l.id=p.loja_id WHERE p.id=?', req.body.produto_id ?? null);
  if (!p || p.classe === 'servicos') return res.status(400).json({ erro: 'Este item não tem frete.' });
  if (!p.cep_origem) return res.status(400).json({ erro: 'A loja ainda não informou o CEP de envio. Combine o frete pelo chat.' });
  try { res.json({ opcoes: await cotarFrete(p, cep) }); }
  catch (e) { res.status(e.status || 502).json({ erro: e.message }); }
});

// ---------- ENDEREÇOS SALVOS DO CLIENTE ----------
app.get('/api/enderecos', logado, async (req, res) =>
  res.json(await all('SELECT id,apelido,cep,estado,cidade,bairro,rua,numero FROM enderecos WHERE usuario_id=? ORDER BY id', req.u.id)));
app.post('/api/enderecos', logado, async (req, res) => {
  const b = req.body, cep = digits(b.cep);
  if (!txt(b.apelido)) return res.status(400).json({ erro: 'Dê um nome ao endereço (ex.: Casa).' });
  if (cep.length !== 8 || !UFS.includes(b.estado) || !txt(b.cidade) || !txt(b.bairro) || !txt(b.rua) || !txt(b.numero))
    return res.status(400).json({ erro: 'Preencha todos os campos do endereço (CEP, estado, cidade, bairro, rua e número).' });
  if ((await get('SELECT COUNT(*) AS n FROM enderecos WHERE usuario_id=?', req.u.id)).n >= 10)
    return res.status(400).json({ erro: 'Você pode salvar até 10 endereços.' });
  await run('INSERT INTO enderecos(usuario_id,apelido,cep,estado,cidade,bairro,rua,numero,criado) VALUES(?,?,?,?,?,?,?,?,?)',
    req.u.id, txt(b.apelido).slice(0, 40), cep, b.estado, txt(b.cidade), txt(b.bairro), txt(b.rua), txt(b.numero), Date.now());
  res.json({ ok: true });
});
app.delete('/api/enderecos/:id', logado, async (req, res) => {
  await run('DELETE FROM enderecos WHERE id=? AND usuario_id=?', req.params.id, req.u.id);
  res.json({ ok: true });
});

// ---------- ACOMPANHAR A ENTREGA (o vendedor atualiza as etapas; o cliente acompanha) ----------
const ETAPAS = ['preparando', 'enviado', 'em_transito', 'entregue'];
const ROTULO = { preparando: 'Preparando o envio', enviado: 'Pedido enviado', em_transito: 'Em trânsito', entregue: 'Entregue' };
app.post('/api/vendedor/pedidos/:id/entrega', vendedor, async (req, res) => {
  const p = await get('SELECT * FROM pedidos WHERE id=? AND loja_id=?', req.params.id, req.loja.id);
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  if (p.status !== 'aprovado' || !p.rua) return res.status(400).json({ erro: 'A entrega só é acompanhada em pedidos aprovados, com endereço de entrega.' });
  const etapa = req.body.etapa;
  if (!ETAPAS.includes(etapa)) return res.status(400).json({ erro: 'Etapa inválida.' });
  const rastreio = txt(req.body.rastreio).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 30);
  if (rastreio && rastreio.length < 8) return res.status(400).json({ erro: 'Código de rastreio inválido.' });
  const nota = txt(req.body.nota).slice(0, 200);
  await run(`UPDATE pedidos SET entrega_etapa=?, rastreio=COALESCE(NULLIF(?,''), rastreio) WHERE id=?`, etapa, rastreio, p.id);
  await run('INSERT INTO entrega_eventos(pedido_id,etapa,nota,criado) VALUES(?,?,?,?)', p.id, etapa, nota || null, Date.now());
  await notificar(p.usuario_id, 'entrega', 'Entrega atualizada 🚚', `#${p.id} · ${ROTULO[etapa]}`, 'meus');
  const cod = rastreio || p.rastreio;      // o cliente é avisado no chat do pedido
  const msg = `📦 Entrega atualizada: ${ROTULO[etapa]}.` + (nota ? ` ${nota}` : '') + (cod && (etapa === 'enviado' || etapa === 'em_transito') ? ` Código de rastreio: ${cod}` : '');
  await run('INSERT INTO mensagens(pedido_id,autor_id,texto,criado) VALUES(?,?,?,?)', p.id, req.u.id, msg, Date.now());
  res.json({ ok: true });
});
app.get('/api/pedidos/:id/entrega', logado, async (req, res) => {
  const p = await acessoPedido(req, res); if (!p) return;
  const eventos = await all('SELECT etapa,nota,criado FROM entrega_eventos WHERE pedido_id=? ORDER BY id', p.id);
  res.json({ status: p.status, tem_end: !!p.rua, aprovado_em: p.aprovado_em || p.criado, etapa: p.entrega_etapa || null,
             rastreio: p.rastreio || null, servico: p.frete_servico || null, prazo: p.frete_prazo || null, eventos });
});

async function migrarCpf() {     // criptografa CPFs antigos que ainda estavam em texto puro
  const rows = await all(`SELECT id,cpf FROM usuarios WHERE cpf ~ '^[0-9]{11}$'`);
  for (const u of rows) await run('UPDATE usuarios SET cpf=? WHERE id=?', cifrar(u.cpf), u.id);
}

// ---------- NOTIFICAÇÕES, CHAT (CAIXA DE ENTRADA) E CONTADORES ----------
const notificar = async (uid, tipo, titulo, texto, destino) => {      // respeita as preferências de notificação de cada pessoa
  if (!uid) return;
  try {
    const u = await get('SELECT prefs_notif FROM usuarios WHERE id=?', uid);
    let p = {}; try { p = JSON.parse((u && u.prefs_notif) || '{}'); } catch (e) {}
    if (p[tipo] === false) return;
    await run('INSERT INTO notificacoes(usuario_id,tipo,titulo,texto,destino,criada) VALUES(?,?,?,?,?,?)', uid, tipo, titulo, texto, destino, Date.now());
  } catch (e) { console.error('notificar:', e.message); }
};
const marcarLida = (uid, chave, ate) => run(
  'INSERT INTO leituras(usuario_id,chave,lida_ate) VALUES(?,?,?) ON CONFLICT (usuario_id,chave) DO UPDATE SET lida_ate=GREATEST(leituras.lida_ate, EXCLUDED.lida_ate)', uid, chave, ate);
app.get('/api/notificacoes', logado, async (req, res) =>
  res.json(await all('SELECT id,tipo,titulo,texto,destino,criada,lida FROM notificacoes WHERE usuario_id=? ORDER BY id DESC LIMIT 50', req.u.id)));
app.post('/api/notificacoes/lidas', logado, async (req, res) => {
  await run('UPDATE notificacoes SET lida=1 WHERE usuario_id=? AND lida=0', req.u.id);
  res.json({ ok: true });
});
const lojaDoUsuario = async u => u.papel === 'vendedor' ? ((await get('SELECT id FROM lojas WHERE usuario_id=?', u.id)) || {}).id || null : null;
app.get('/api/badges', logado, async (req, res) => {       // números que aparecem nas abas
  const eu = req.u.id, lojaId = await lojaDoUsuario(req.u);
  const n = (await get('SELECT COUNT(*) AS n FROM notificacoes WHERE usuario_id=? AND lida=0', eu)).n;
  const c = (await get(`SELECT COUNT(*) AS n FROM mensagens m
      LEFT JOIN pedidos p ON p.id=m.pedido_id
      LEFT JOIN leituras l ON l.usuario_id=? AND l.chave = CASE WHEN m.pedido_id IS NOT NULL THEN 'p:'||m.pedido_id ELSE 'l:'||m.loja_id||':'||m.cliente_id END
    WHERE ((m.pedido_id IS NOT NULL AND (p.usuario_id=? OR p.loja_id=?)) OR (m.pedido_id IS NULL AND (m.cliente_id=? OR m.loja_id=?)))
      AND m.id > COALESCE(l.lida_ate,0) AND m.autor_id IS DISTINCT FROM ?`, eu, eu, lojaId, eu, lojaId, eu)).n;
  res.json({ notif: n, chat: c });
});
app.get('/api/conversas', logado, async (req, res) => {    // caixa de entrada: pedidos e conversas com lojas
  const eu = req.u.id, lojaId = await lojaDoUsuario(req.u);
  const rows = await all(`WITH mm AS (
      SELECT m.id, m.autor_id, CASE WHEN m.pedido_id IS NOT NULL THEN 'p:'||m.pedido_id ELSE 'l:'||m.loja_id||':'||m.cliente_id END AS chave
      FROM mensagens m LEFT JOIN pedidos p ON p.id=m.pedido_id
      WHERE (m.pedido_id IS NOT NULL AND (p.usuario_id=? OR p.loja_id=?)) OR (m.pedido_id IS NULL AND (m.cliente_id=? OR m.loja_id=?)))
    SELECT mm.chave, MAX(mm.id) AS ultimo_id, COUNT(*) FILTER (WHERE mm.id > COALESCE(l.lida_ate,0) AND mm.autor_id IS DISTINCT FROM ?) AS nao_lidas
    FROM mm LEFT JOIN leituras l ON l.usuario_id=? AND l.chave=mm.chave
    GROUP BY mm.chave, l.lida_ate ORDER BY ultimo_id DESC LIMIT 50`, eu, lojaId, eu, lojaId, eu, eu);
  if (!rows.length) return res.json([]);
  for (const r of rows) { const [t, a, b] = r.chave.split(':'); r.t = t; r.a = Number(a); r.b = Number(b); }
  const pids = rows.filter(r => r.t === 'p').map(r => r.a), lids = rows.filter(r => r.t === 'l').map(r => r.a), cids = rows.filter(r => r.t === 'l').map(r => r.b);
  const P = pids.length ? await all(`SELECT p.id,p.item,p.nome,p.usuario_id,l.nome AS loja FROM pedidos p JOIN lojas l ON l.id=p.loja_id WHERE p.id IN (${pids.join(',')})`) : [];
  const Ls = lids.length ? await all(`SELECT id,nome FROM lojas WHERE id IN (${lids.join(',')})`) : [];
  const Cs = cids.length ? await all(`SELECT id,email FROM usuarios WHERE id IN (${cids.join(',')})`) : [];
  const U = await all(`SELECT id,texto,criado FROM mensagens WHERE id IN (${rows.map(r => Number(r.ultimo_id)).join(',')})`);
  res.json(rows.map(r => {
    const u = U.find(x => x.id === r.ultimo_id) || {};
    if (r.t === 'p') {
      const p = P.find(x => x.id === r.a) || {};
      return { url: `/api/pedidos/${r.a}/mensagens`, titulo: `#${r.a} · ${p.item || 'Pedido'}`, sub: p.usuario_id === eu ? p.loja : `Comprador: ${p.nome}`, ultima: u.texto || '', quando: u.criado, nao_lidas: r.nao_lidas };
    }
    const comprador = r.b === eu;
    return { url: comprador ? `/api/lojas/${r.a}/mensagens` : `/api/vendedor/conversas/${r.b}/mensagens`,
      titulo: comprador ? ((Ls.find(x => x.id === r.a) || {}).nome || 'Loja') : ((Cs.find(x => x.id === r.b) || {}).email || 'Cliente'),
      sub: 'Conversa antes da compra', ultima: u.texto || '', quando: u.criado, nao_lidas: r.nao_lidas };
  }));
});

// Digital Asset Links: prova ao Android que o app (APK) pertence a este site e some com a barra do navegador.
// O conteúdo vem da variável ASSETLINKS_JSON do Render (o PWABuilder gera esse arquivo junto com o APK).
app.get('/.well-known/assetlinks.json', (req, res) => {
  // aceita o texto da variável ASSETLINKS_JSON (com ou sem aspas em volta) ou, se ela não existir, o arquivo public/assetlinks.json
  let txt = String(process.env.ASSETLINKS_JSON || '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  if (!txt) { try { txt = fs.readFileSync(path.join(PUBLIC, 'assetlinks.json'), 'utf8'); } catch (e) { txt = '[]'; } }
  try { res.json(JSON.parse(txt)); }
  catch (e) { res.status(500).json({ erro: 'O conteúdo do assetlinks não é um JSON válido. Cole o arquivo inteiro, começando em [ e terminando em ].' }); }
});

// ---------- SENHA E PAINEL DE SEGURANÇA ----------
app.post('/api/senha', logado, limite('senha', 10, 3600000, true), async (req, res) => {
  const { atual, nova, confirmar } = req.body;
  if (!(await bcrypt.compare(String(atual || '').slice(0, 100), req.u.senha_hash))) return res.status(400).json({ erro: 'A senha atual está incorreta.' });
  if (!senhaForte(nova)) return res.status(400).json({ erro: 'A nova senha precisa ter de 8 a 72 caracteres, com letras e números.' });
  if (nova !== confirmar) return res.status(400).json({ erro: 'As senhas não são iguais.' });
  await run('UPDATE usuarios SET senha_hash=? WHERE id=?', await bcrypt.hash(nova, 12), req.u.id);
  try { await run(`DELETE FROM session WHERE (sess::jsonb ->> 'uid') = ? AND sid <> ?`, String(req.u.id), req.sessionID); }   // sai de todos os outros aparelhos
  catch (e) { console.error('Encerrar outras sessões:', e.message); }
  res.json({ ok: true });
});
app.get('/api/admin/seguranca', admin, async (req, res) => {
  const sem = await all(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity`);
  res.json({ https: /^https:\/\//.test(SITE_URL), segredo: (process.env.SEGREDO || '').length >= 24, admin_email: !!ADMIN_EMAIL,
             rls: sem.length === 0, sem_rls: sem.map(x => x.tablename), csp_ativo: !process.env.CSP_REPORT_ONLY });
});

// ---------- CONFIGURAÇÕES DA CONTA (preferências, dados e exclusão — direitos da LGPD) ----------
const PREFS_PADRAO = { pedido: true, entrega: true, pagamento: true };
const lerPrefs = u => { try { return { ...PREFS_PADRAO, ...JSON.parse(u.prefs_notif || '{}') }; } catch (e) { return { ...PREFS_PADRAO }; } };
app.get('/api/config', logado, (req, res) => res.json({ email: req.u.email, papel: req.u.papel, prefs: lerPrefs(req.u) }));
app.put('/api/config/notificacoes', logado, async (req, res) => {
  const p = {}; for (const k of Object.keys(PREFS_PADRAO)) p[k] = req.body[k] !== false;
  await run('UPDATE usuarios SET prefs_notif=? WHERE id=?', JSON.stringify(p), req.u.id);
  res.json({ ok: true });
});
app.post('/api/conta/sair-todos', logado, async (req, res) => {
  try { await run(`DELETE FROM session WHERE (sess::jsonb ->> 'uid') = ?`, String(req.u.id)); } catch (e) { console.error('Encerrar sessões:', e.message); }
  req.session.destroy(() => { res.clearCookie('kivra.sid'); res.json({ ok: true }); });
});
app.get('/api/meus-dados', logado, async (req, res) => {      // cópia dos dados da própria pessoa (portabilidade)
  const u = req.u; let cpf = null;
  if (u.cpf) { try { cpf = decifrar(u.cpf); } catch (e) { cpf = u.cpf; } }
  const loja = u.papel === 'vendedor' ? await get('SELECT nome,slug,quem_somos,cep_origem,loja_estado,loja_cidade,loja_bairro,loja_rua,loja_numero FROM lojas WHERE usuario_id=?', u.id) : null;
  res.json({ gerado_em: Date.now(),
    conta: { email: u.email, tipo: u.papel, cpf, criada_em: u.criado, aceitou_a_politica_em: u.aceite_politica },
    loja,
    enderecos: await all('SELECT apelido,cep,estado,cidade,bairro,rua,numero FROM enderecos WHERE usuario_id=? ORDER BY id', u.id),
    pedidos: await all('SELECT id,item,preco,metodo,status,nome,cep,estado,cidade,bairro,rua,numero,telefone,frete_servico,frete_valor,criado FROM pedidos WHERE usuario_id=? ORDER BY id', u.id),
    mensagens_enviadas: await all('SELECT pedido_id,texto,criado FROM mensagens WHERE autor_id=? ORDER BY id', u.id) });
});
app.post('/api/conta/excluir', logado, limite('excluir', 5, 3600000, true), async (req, res) => {
  if (req.u.papel === 'admin') return res.status(400).json({ erro: 'A conta de administrador não pode ser excluída por aqui.' });
  if (!(await bcrypt.compare(String(req.body.senha || '').slice(0, 100), req.u.senha_hash))) return res.status(400).json({ erro: 'Senha incorreta.' });
  const id = req.u.id, loja = req.u.papel === 'vendedor' ? await get('SELECT id FROM lojas WHERE usuario_id=?', id) : null;
  if (loja && (await get('SELECT COUNT(*) AS n FROM pedidos WHERE loja_id=?', loja.id)).n > 0)
    return res.status(400).json({ erro: 'A sua loja tem pedidos registrados. Para excluir a conta, escreva para o e-mail de contato da Política de Privacidade.' });
  if (loja) {
    for (const t of ['produtos', 'cupons', 'vales', 'avisos']) await run(`DELETE FROM ${t} WHERE loja_id=?`, loja.id);
    await run('DELETE FROM mensagens WHERE loja_id=?', loja.id); await run('DELETE FROM lojas WHERE id=?', loja.id);
  }
  // pedidos antigos ficam sem os dados pessoais (anonimizados); o restante é apagado
  await run(`UPDATE pedidos SET usuario_id=NULL, nome='Cliente removido', telefone=NULL, cep=NULL, cidade=NULL, bairro=NULL, rua=NULL, numero=NULL, ip=NULL WHERE usuario_id=?`, id);
  await run(`UPDATE mensagens SET autor_id=NULL, texto='[mensagem removida]' WHERE autor_id=?`, id);
  await run('DELETE FROM mensagens WHERE pedido_id IS NULL AND cliente_id=?', id);
  for (const t of ['enderecos', 'notificacoes']) await run(`DELETE FROM ${t} WHERE usuario_id=?`, id);
  await run('DELETE FROM leituras WHERE usuario_id=?', id);
  try { await run(`DELETE FROM session WHERE (sess::jsonb ->> 'uid') = ?`, String(id)); } catch (e) { console.error('Encerrar sessões:', e.message); }
  await run('DELETE FROM usuarios WHERE id=?', id);
  req.session.destroy(() => { res.clearCookie('kivra.sid'); res.json({ ok: true }); });
});

// ---------- SITE ----------
const PUBLIC = path.join(__dirname, 'public');
const INDEX = (() => { try { return fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'); } catch (e) { return null; } })();
// Política de segurança do navegador: só roda o script que o servidor assina com um código novo a cada visita
const csp = (n, https) => ["default-src 'self'", `script-src 'self' 'nonce-${n}'`, "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com', "img-src 'self' data: blob:", "media-src 'self' blob:",
  "connect-src 'self' https://viacep.com.br https://servicodados.ibge.gov.br", "worker-src 'self'", "manifest-src 'self'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", ...(https ? ['upgrade-insecure-requests'] : [])].join('; ');
app.get(['/', '/index.html'], (req, res) => {
  if (!INDEX) return res.status(404).send('<h3>index.html não encontrado na pasta public</h3>');
  const nonce = crypto.randomBytes(16).toString('base64');
  res.set(process.env.CSP_REPORT_ONLY ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', csp(nonce, req.secure));
  res.set('Cache-Control', 'no-cache').type('html').send(INDEX.replace(/<script>/g, `<script nonce="${nonce}">`));
});
app.use(express.static(PUBLIC, { index: false, setHeaders: (res, p) => {
  if (/(sw\.js|manifest\.json)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
  if (/offline\.html$/.test(p)) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
} }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ erro: 'Arquivo ou texto grande demais.' });
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) return res.status(400).json({ erro: 'Requisição inválida.' });
  console.error(err); res.status(500).json({ erro: 'Erro interno do servidor.' });
});

// liga a proteção por linha (RLS) em todas as tabelas e tira o acesso público da API do Supabase; o servidor usa a conexão direta e não é afetado
async function blindarBanco() {
  try {
    await pool.query(`DO $$ DECLARE t text; BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t); END LOOP;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
        EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon'; EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon'; END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
        EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated'; EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated'; END IF;
    END $$;`);
  } catch (e) { console.error('Aviso: não foi possível ativar o RLS:', e.message); }
}

criarTabelas().then(migrarCpf).then(blindarBanco).then(() => {
  app.listen(process.env.PORT || 3000, () => console.log('Kivra rodando na porta ' + (process.env.PORT || 3000)));
  setTimeout(blindarBanco, 90000).unref();   // pega também a tabela de sessões, criada no primeiro acesso
}).catch(e => { console.error('Falha ao conectar no banco:', e.message); process.exit(1); });
