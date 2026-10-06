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
  CREATE INDEX IF NOT EXISTS idx_msg_pedido ON mensagens(pedido_id);`);
}

// ---------- REGRAS ----------
const CLASSES = { roupas: ['tamanho'], calcados: ['tamanho'], bolsas: [], perfumes: ['nome'], cosmeticos: ['nome'] };
const VALES = [10, 30, 50, 70, 100, 200, 250, 300, 400, 500];
const MAX_CUPOM = 50;
const digits = s => String(s || '').replace(/\D/g, '');
const txt = s => String(s ?? '').trim();
const ehImagem = s => typeof s === 'string' && s.startsWith('data:image/');
function cpfOk(c) {
  c = digits(c); if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (const k of [9, 10]) { let s = 0; for (let i = 0; i < k; i++) s += c[i] * (k + 1 - i); if (((s * 10) % 11) % 10 !== Number(c[k])) return false; }
  return true;
}
const slugar = s => txt(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'loja';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '6mb' }));
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }), // login guardado no Supabase
  secret: process.env.SEGREDO || 'troque-este-segredo', resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 30 * 24 * 3600 * 1000 },
}));
app.use(async (req, res, next) => {
  req.u = req.session.uid ? await get('SELECT * FROM usuarios WHERE id=?', req.session.uid) : null;
  if (req.u && req.u.bloqueado) { req.u = null; req.session.uid = null; }
  next();
});
const logado = (req, res, next) => req.u ? next() : res.status(401).json({ erro: 'Entre na sua conta.' });
const vendedor = async (req, res, next) => {
  if (!req.u || req.u.papel !== 'vendedor') return res.status(403).json({ erro: 'Apenas vendedores.' });
  req.loja = await get('SELECT id,usuario_id,slug,nome,quem_somos,whatsapp,pix FROM lojas WHERE usuario_id=?', req.u.id); next();
};
const admin = (req, res, next) =>
  req.u && req.u.papel === 'admin' && req.u.email === ADMIN_EMAIL ? next() : res.status(403).json({ erro: 'Acesso negado.' });

// ---------- CONTA ----------
app.post('/api/cadastro', async (req, res) => {
  const { senha, confirmar, cpf, nomeLoja } = req.body;
  const email = txt(req.body.email).toLowerCase();
  const tipo = req.body.tipo === 'vendedor' ? 'vendedor' : 'cliente';
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
  if (!senha || senha.length < 6) return res.status(400).json({ erro: 'Senha com no mínimo 6 caracteres.' });
  if (senha !== confirmar) return res.status(400).json({ erro: 'As senhas não são iguais.' });
  if (await get('SELECT 1 AS x FROM usuarios WHERE email=?', email)) return res.status(400).json({ erro: 'E-mail já cadastrado.' });
  if (tipo === 'vendedor' && (!cpfOk(cpf) || !txt(nomeLoja))) return res.status(400).json({ erro: 'Vendedor precisa de CPF válido e nome da loja.' });
  const papel = email === ADMIN_EMAIL ? 'admin' : tipo;
  const u = await get('INSERT INTO usuarios(email,senha_hash,papel,cpf,criado) VALUES(?,?,?,?,?) RETURNING id',
    email, bcrypt.hashSync(senha, 10), papel, tipo === 'vendedor' ? digits(cpf) : null, Date.now());
  if (tipo === 'vendedor') {
    let slug = slugar(nomeLoja); if (await get('SELECT 1 AS x FROM lojas WHERE slug=?', slug)) slug += '-' + crypto.randomBytes(2).toString('hex');
    await run('INSERT INTO lojas(usuario_id,slug,nome) VALUES(?,?,?)', u.id, slug, txt(nomeLoja));
  }
  req.session.uid = u.id; res.json({ ok: true });
});
app.post('/api/login', async (req, res) => {
  const u = await get('SELECT * FROM usuarios WHERE email=?', txt(req.body.email).toLowerCase());
  if (!u || !bcrypt.compareSync(req.body.senha || '', u.senha_hash)) return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  if (u.bloqueado) return res.status(403).json({ erro: 'Conta bloqueada. Fale com o administrador.' });
  req.session.uid = u.id; res.json({ ok: true });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/eu', async (req, res) => {
  if (!req.u) return res.json({ logado: false });
  const loja = req.u.papel === 'vendedor' ? await get('SELECT id,usuario_id,slug,nome,quem_somos,whatsapp,pix FROM lojas WHERE usuario_id=?', req.u.id) : null;
  res.json({ logado: true, email: req.u.email, papel: req.u.papel, loja });
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
  res.json(await all(sql + ' ORDER BY p.criado DESC', ...a));
});
app.get('/api/lojas/:slug', async (req, res) => {
  const l = await get(`SELECT l.id,l.nome,l.slug,l.quem_somos,l.whatsapp,l.avatar,l.banner FROM lojas l JOIN usuarios u ON u.id=l.usuario_id
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
  if (ehImagem(req.body.avatar)) await run('UPDATE lojas SET avatar=? WHERE id=?', req.body.avatar, req.loja.id);
  if (ehImagem(req.body.banner)) await run('UPDATE lojas SET banner=? WHERE id=?', req.body.banner, req.loja.id);
  res.json({ ok: true });
});
app.get('/api/vendedor/produtos', vendedor, async (req, res) => res.json(await all('SELECT * FROM produtos WHERE loja_id=? ORDER BY criado DESC', req.loja.id)));
app.post('/api/vendedor/produtos', vendedor, async (req, res) => {
  const { classe, nome, tamanho, descricao, preco, foto, estoque } = req.body;
  if (!CLASSES[classe]) return res.status(400).json({ erro: 'Classe inválida.' });
  const d = { nome: txt(nome), tamanho: txt(tamanho) };
  for (const c of CLASSES[classe]) if (!d[c]) return res.status(400).json({ erro: `Informe o campo: ${c}.` });
  if (!txt(descricao)) return res.status(400).json({ erro: 'Informe a descrição.' });
  if (!(Number(preco) > 0)) return res.status(400).json({ erro: 'Preço inválido.' });
  if (!ehImagem(foto)) return res.status(400).json({ erro: 'Adicione a foto.' });
  await run('INSERT INTO produtos(loja_id,classe,nome,tamanho,descricao,preco,estoque,foto,criado) VALUES(?,?,?,?,?,?,?,?,?)',
    req.loja.id, classe, d.nome, d.tamanho, txt(descricao), Number(preco), Math.max(1, parseInt(estoque) || 1), foto, Date.now());
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
  const codigo = 'VP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  await run('INSERT INTO vales(loja_id,codigo,valor,criado) VALUES(?,?,?,?)', req.loja.id, codigo, valor, Date.now());
  res.json({ ok: true, codigo, valor });
});
app.post('/api/vendedor/avisos', vendedor, async (req, res) => {
  const tipo = req.body.tipo === 'estoque' ? 'estoque' : 'promocao';
  if (!txt(req.body.titulo)) return res.status(400).json({ erro: 'Informe o título.' });
  await run('INSERT INTO avisos(loja_id,tipo,titulo,texto,criado) VALUES(?,?,?,?,?)', req.loja.id, tipo, txt(req.body.titulo), txt(req.body.texto), Date.now());
  res.json({ ok: true });
});
app.get('/api/vendedor/pedidos', vendedor, async (req, res) =>
  res.json(await all(`SELECT * FROM pedidos WHERE loja_id=? ORDER BY criado ${req.query.ordem === 'antigos' ? 'ASC' : 'DESC'}`, req.loja.id)));

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
app.post('/api/pedidos', logado, async (req, res) => {
  const b = req.body; let loja_id, item, preco, produto_id = null;
  if (b.vale_valor) {
    const l = await get('SELECT id FROM lojas WHERE id=?', b.loja_id);
    if (!l || !VALES.includes(Number(b.vale_valor))) return res.status(400).json({ erro: 'Vale inválido.' });
    loja_id = l.id; item = `Vale presente R$ ${Number(b.vale_valor)}`; preco = Number(b.vale_valor);
  } else {
    const p = await get('SELECT p.*, u.bloqueado FROM produtos p JOIN lojas l ON l.id=p.loja_id JOIN usuarios u ON u.id=l.usuario_id WHERE p.id=?', b.produto_id ?? null);
    if (!p || p.bloqueado) return res.status(404).json({ erro: 'Produto não encontrado.' });
    if (p.estoque < 1) return res.status(400).json({ erro: 'Produto sem estoque.' });
    loja_id = p.loja_id; produto_id = p.id; item = p.nome || p.classe; preco = p.preco;
  }
  if (!txt(b.nome) || !txt(b.cidade) || !txt(b.bairro) || !txt(b.rua) || !txt(b.numero)) return res.status(400).json({ erro: 'Preencha todos os campos.' });
  if (digits(b.cep).length !== 8) return res.status(400).json({ erro: 'CEP inválido.' });
  if (digits(b.telefone).length < 10) return res.status(400).json({ erro: 'Telefone inválido (DDD + número).' });
  if (!['pix', 'credito', 'debito'].includes(b.metodo)) return res.status(400).json({ erro: 'Forma de pagamento inválida.' });

  let desconto = 0, cupom = null;
  if (txt(b.cupom) && produto_id) {
    const c = await get('SELECT * FROM cupons WHERE loja_id=? AND codigo=? AND ativo=1', loja_id, txt(b.cupom).toUpperCase());
    if (!c) return res.status(400).json({ erro: 'Cupom inválido.' });
    desconto = Math.min(c.tipo === 'percentual' ? preco * c.valor / 100 : c.valor, preco * MAX_CUPOM / 100); cupom = c.codigo;
  }
  let vale = null;
  if (txt(b.vale_codigo) && produto_id) {
    vale = await get('SELECT * FROM vales WHERE loja_id=? AND codigo=? AND usado=0', loja_id, txt(b.vale_codigo).toUpperCase());
    if (!vale) return res.status(400).json({ erro: 'Vale presente inválido ou já usado.' });
    desconto += Math.min(vale.valor, preco - desconto);
  }
  const final = Math.max(preco - desconto, 0);
  const ped = await get(`INSERT INTO pedidos(loja_id,usuario_id,ip,produto_id,item,preco_original,desconto,preco,cupom,metodo,nome,cep,cidade,bairro,rua,numero,telefone,comprovante,criado)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    loja_id, req.u.id, req.ip, produto_id, item, preco, desconto, final, cupom, b.metodo, txt(b.nome), digits(b.cep),
    txt(b.cidade), txt(b.bairro), txt(b.rua), txt(b.numero), digits(b.telefone), ehImagem(b.comprovante) ? b.comprovante : null, Date.now());
  if (produto_id) await run('UPDATE produtos SET estoque=estoque-1 WHERE id=?', produto_id);
  if (vale) await run('UPDATE vales SET usado=1 WHERE id=?', vale.id);
  const l = await get('SELECT whatsapp,pix FROM lojas WHERE id=?', loja_id);
  res.json({ ok: true, id: ped.id, total: final, whatsapp: l.whatsapp, pix: l.pix });
});
app.get('/api/meus-pedidos', logado, async (req, res) =>
  res.json(await all(`SELECT p.id,p.item,p.preco,p.metodo,p.status,p.criado,(p.comprovante IS NOT NULL) AS tem_comp,l.nome AS loja_nome
                      FROM pedidos p LEFT JOIN lojas l ON l.id=p.loja_id WHERE p.usuario_id=? ORDER BY p.criado DESC`, req.u.id)));

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
  res.json({ mensagens: m.map(x => ({ id: x.id, texto: x.texto, criado: x.criado, minha: x.autor_id === req.u.id })) });
});
app.post('/api/pedidos/:id/mensagens', logado, async (req, res) => {
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
  await run('UPDATE pedidos SET status=? WHERE id=?', st, p.id);
  let msg = st === 'aprovado' ? 'Pedido aprovado ✅' : 'Pedido recusado ❌. Se tiver dúvidas, fale comigo por aqui.';
  if (st === 'recusado' && p.produto_id) await run('UPDATE produtos SET estoque=estoque+1 WHERE id=?', p.produto_id);
  if (st === 'aprovado' && !p.produto_id) {       // vale presente: gera o código na aprovação
    const codigo = 'VP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    await run('INSERT INTO vales(loja_id,codigo,valor,criado) VALUES(?,?,?,?)', req.loja.id, codigo, p.preco_original, Date.now());
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
  await run('UPDATE pedidos SET usuario_id=NULL WHERE usuario_id=?', u.id);
  await run('DELETE FROM usuarios WHERE id=?', u.id); res.json({ ok: true });
});
app.get('/api/admin/relatorio', admin, async (req, res) => res.json(await relatorio(null)));

// ---------- SITE ----------
const PUBLIC = path.join(__dirname, 'public');
app.use(express.static(PUBLIC));
app.get('/', (req, res) => {
  const f = path.join(PUBLIC, 'index.html');
  fs.existsSync(f) ? res.sendFile(f) : res.status(404).send('<h3>index.html não encontrado na pasta public</h3>');
});
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ erro: 'Erro interno do servidor.' }); });

criarTabelas().then(() => app.listen(process.env.PORT || 3000, () => console.log('Kivra rodando na porta ' + (process.env.PORT || 3000))))
  .catch(e => { console.error('Falha ao conectar no banco:', e.message); process.exit(1); });
