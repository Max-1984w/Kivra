const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// >>> TROQUE PELO SEU E-MAIL: quem se cadastrar com ele vira o ADM <<<
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'junior927386@gmail.com').toLowerCase();

// ---------- 1. BANCO (arquivo novo: kivra.db) ----------
const db = new DatabaseSync(path.join(__dirname, 'kivra.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS usuarios(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, senha_hash TEXT,
  papel TEXT DEFAULT 'cliente', cpf TEXT, bloqueado INTEGER DEFAULT 0, criado INTEGER);
CREATE TABLE IF NOT EXISTS lojas(id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER UNIQUE, slug TEXT UNIQUE,
  nome TEXT, quem_somos TEXT DEFAULT '', whatsapp TEXT DEFAULT '', pix TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS produtos(id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER, classe TEXT, nome TEXT DEFAULT '',
  tamanho TEXT DEFAULT '', descricao TEXT, preco REAL, estoque INTEGER DEFAULT 1, foto TEXT, criado INTEGER);
CREATE TABLE IF NOT EXISTS cupons(id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER, codigo TEXT, tipo TEXT, valor REAL, ativo INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS vales(id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER, codigo TEXT UNIQUE, valor REAL, usado INTEGER DEFAULT 0, criado INTEGER);
CREATE TABLE IF NOT EXISTS avisos(id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER, tipo TEXT, titulo TEXT, texto TEXT, criado INTEGER);
CREATE TABLE IF NOT EXISTS pedidos(id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id INTEGER, usuario_id INTEGER, ip TEXT, produto_id INTEGER,
  item TEXT, preco_original REAL, desconto REAL, preco REAL, cupom TEXT, metodo TEXT, nome TEXT, cep TEXT, cidade TEXT,
  bairro TEXT, rua TEXT, numero TEXT, telefone TEXT, comprovante TEXT, criado INTEGER);
`);
// atalhos (o SQLite do Node não aceita "undefined", então trocamos por null)
const fix = p => p.map(x => (x === undefined ? null : x));
const run = (s, ...p) => db.prepare(s).run(...fix(p));
const get = (s, ...p) => db.prepare(s).get(...fix(p));
const all = (s, ...p) => db.prepare(s).all(...fix(p));

// ---------- 2. REGRAS ----------
const CLASSES = { roupas: ['tamanho'], calcados: ['tamanho'], bolsas: [], perfumes: ['nome'], cosmeticos: ['nome'] };
const VALES = [10, 30, 50, 70, 100, 200, 250, 300, 400, 500];
const MAX_CUPOM = 50; // % máximo
const digits = s => String(s || '').replace(/\D/g, '');
const txt = s => String(s ?? '').trim();
const ehImagem = s => typeof s === 'string' && s.startsWith('data:image/');
function cpfOk(c) {
  c = digits(c); if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (const n of [9, 10]) { let s = 0; for (let i = 0; i < n; i++) s += c[i] * (n + 1 - i); if (((s * 10) % 11) % 10 !== Number(c[n])) return false; }
  return true;
}
const slugar = s => txt(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'loja';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '6mb' }));
app.use(session({ secret: process.env.SEGREDO || 'troque-este-segredo', resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' } }));

// carrega o usuário a cada requisição (assim, bloquear vale na hora)
app.use((req, res, next) => {
  req.u = req.session.uid ? get('SELECT * FROM usuarios WHERE id=?', req.session.uid) : null;
  if (req.u && req.u.bloqueado) { req.u = null; req.session.uid = null; }
  next();
});
const logado = (req, res, next) => req.u ? next() : res.status(401).json({ erro: 'Entre na sua conta.' });
const vendedor = (req, res, next) => {
  if (!req.u || req.u.papel !== 'vendedor') return res.status(403).json({ erro: 'Apenas vendedores.' });
  req.loja = get('SELECT * FROM lojas WHERE usuario_id=?', req.u.id); next();
};
const admin = (req, res, next) =>
  req.u && req.u.papel === 'admin' && req.u.email === ADMIN_EMAIL ? next() : res.status(403).json({ erro: 'Acesso negado.' });

// ---------- 3. CONTA ----------
app.post('/api/cadastro', (req, res) => {
  const { senha, confirmar, cpf, nomeLoja } = req.body;
  const email = txt(req.body.email).toLowerCase();
  const tipo = req.body.tipo === 'vendedor' ? 'vendedor' : 'cliente';
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
  if (!senha || senha.length < 6) return res.status(400).json({ erro: 'Senha com no mínimo 6 caracteres.' });
  if (senha !== confirmar) return res.status(400).json({ erro: 'As senhas não são iguais.' });
  if (get('SELECT 1 FROM usuarios WHERE email=?', email)) return res.status(400).json({ erro: 'E-mail já cadastrado.' });
  if (tipo === 'vendedor' && (!cpfOk(cpf) || !txt(nomeLoja)))
    return res.status(400).json({ erro: 'Vendedor precisa de CPF válido e nome da loja.' });
  const papel = email === ADMIN_EMAIL ? 'admin' : tipo;
  const info = run('INSERT INTO usuarios(email,senha_hash,papel,cpf,criado) VALUES(?,?,?,?,?)',
    email, bcrypt.hashSync(senha, 10), papel, tipo === 'vendedor' ? digits(cpf) : null, Date.now());
  if (tipo === 'vendedor') {
    let slug = slugar(nomeLoja); if (get('SELECT 1 FROM lojas WHERE slug=?', slug)) slug += '-' + crypto.randomBytes(2).toString('hex');
    run('INSERT INTO lojas(usuario_id,slug,nome) VALUES(?,?,?)', info.lastInsertRowid, slug, txt(nomeLoja));
  }
  req.session.uid = Number(info.lastInsertRowid);
  res.json({ ok: true });
});
app.post('/api/login', (req, res) => {
  const u = get('SELECT * FROM usuarios WHERE email=?', txt(req.body.email).toLowerCase());
  if (!u || !bcrypt.compareSync(req.body.senha || '', u.senha_hash)) return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  if (u.bloqueado) return res.status(403).json({ erro: 'Conta bloqueada. Fale com o administrador.' });
  req.session.uid = u.id; res.json({ ok: true });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/eu', (req, res) => {
  if (!req.u) return res.json({ logado: false });
  const loja = req.u.papel === 'vendedor' ? get('SELECT * FROM lojas WHERE usuario_id=?', req.u.id) : null;
  res.json({ logado: true, email: req.u.email, papel: req.u.papel, loja });
});

// ---------- 4. VITRINE PÚBLICA (sem login) ----------
// Busca: ?q=texto &classe= &min= &max= &loja=slug
app.get('/api/produtos', (req, res) => {
  const { q, classe, min, max, loja } = req.query;
  let sql = `SELECT p.*, l.nome AS loja_nome, l.slug FROM produtos p JOIN lojas l ON l.id=p.loja_id
             JOIN usuarios u ON u.id=l.usuario_id WHERE u.bloqueado=0 AND p.estoque>0`; const a = [];
  if (txt(q)) { sql += ' AND (p.nome LIKE ? OR p.descricao LIKE ?)'; a.push(`%${txt(q)}%`, `%${txt(q)}%`); }
  if (classe) { sql += ' AND p.classe=?'; a.push(classe); }
  if (min !== undefined && min !== '') { sql += ' AND p.preco>=?'; a.push(Number(min)); }
  if (max !== undefined && max !== '') { sql += ' AND p.preco<=?'; a.push(Number(max)); }
  if (loja) { sql += ' AND l.slug=?'; a.push(loja); }
  res.json(all(sql + ' ORDER BY p.criado DESC', ...a));
});
// Perfil da loja ("Quem somos nós?"), com vales à venda
app.get('/api/lojas/:slug', (req, res) => {
  const l = get(`SELECT l.id,l.nome,l.slug,l.quem_somos,l.whatsapp FROM lojas l JOIN usuarios u ON u.id=l.usuario_id
                 WHERE l.slug=? AND u.bloqueado=0`, req.params.slug);
  if (!l) return res.status(404).json({ erro: 'Loja não encontrada.' });
  const precos = get('SELECT MIN(preco) min, MAX(preco) max FROM produtos WHERE loja_id=? AND estoque>0', l.id);
  res.json({ ...l, faixa_preco: precos, vales: VALES });
});
app.get('/api/lojas', (req, res) => res.json(all(
  `SELECT l.nome,l.slug FROM lojas l JOIN usuarios u ON u.id=l.usuario_id WHERE u.bloqueado=0 ORDER BY l.nome`)));
// Aba inicial Kivra: promoções e atualizações de estoque
app.get('/api/inicio', (req, res) => res.json(all(
  `SELECT a.tipo,a.titulo,a.texto,a.criado,l.nome AS loja_nome,l.slug FROM avisos a JOIN lojas l ON l.id=a.loja_id
   JOIN usuarios u ON u.id=l.usuario_id WHERE u.bloqueado=0 ORDER BY a.criado DESC LIMIT 30`)));

// ---------- 5. VENDEDOR ----------
app.put('/api/vendedor/loja', vendedor, (req, res) => {
  const w = digits(req.body.whatsapp);
  if (!txt(req.body.nome)) return res.status(400).json({ erro: 'Informe o nome da loja.' });
  if (w && w.length < 10) return res.status(400).json({ erro: 'WhatsApp inválido.' });
  run('UPDATE lojas SET nome=?, quem_somos=?, whatsapp=?, pix=? WHERE id=?',
    txt(req.body.nome), txt(req.body.quem_somos), w, txt(req.body.pix), req.loja.id);
  res.json({ ok: true, link: `/?loja=${req.loja.slug}` }); // o site monta: endereço do site + este link
});
app.get('/api/vendedor/produtos', vendedor, (req, res) => res.json(all('SELECT * FROM produtos WHERE loja_id=? ORDER BY criado DESC', req.loja.id)));
app.post('/api/vendedor/produtos', vendedor, (req, res) => {
  const { classe, nome, tamanho, descricao, preco, foto, estoque } = req.body;
  if (!CLASSES[classe]) return res.status(400).json({ erro: 'Classe inválida.' });
  const d = { nome: txt(nome), tamanho: txt(tamanho) };
  for (const c of CLASSES[classe]) if (!d[c]) return res.status(400).json({ erro: `Informe o campo: ${c}.` });
  if (!txt(descricao)) return res.status(400).json({ erro: 'Informe a descrição.' });
  if (!(Number(preco) > 0)) return res.status(400).json({ erro: 'Preço inválido.' });
  if (!ehImagem(foto)) return res.status(400).json({ erro: 'Adicione a foto.' });
  const est = Math.max(1, parseInt(estoque) || 1);
  run('INSERT INTO produtos(loja_id,classe,nome,tamanho,descricao,preco,estoque,foto,criado) VALUES(?,?,?,?,?,?,?,?,?)',
    req.loja.id, classe, d.nome, d.tamanho, txt(descricao), Number(preco), est, foto, Date.now());
  res.json({ ok: true });
});
app.put('/api/vendedor/produtos/:id/estoque', vendedor, (req, res) => {
  const est = parseInt(req.body.estoque); if (!(est >= 0)) return res.status(400).json({ erro: 'Estoque inválido.' });
  run('UPDATE produtos SET estoque=? WHERE id=? AND loja_id=?', est, req.params.id, req.loja.id); res.json({ ok: true });
});
app.delete('/api/vendedor/produtos/:id', vendedor, (req, res) => { run('DELETE FROM produtos WHERE id=? AND loja_id=?', req.params.id, req.loja.id); res.json({ ok: true }); });

app.get('/api/vendedor/cupons', vendedor, (req, res) => res.json(all('SELECT * FROM cupons WHERE loja_id=?', req.loja.id)));
app.post('/api/vendedor/cupons', vendedor, (req, res) => {
  const codigo = txt(req.body.codigo).toUpperCase(), tipo = req.body.tipo, valor = Number(req.body.valor);
  if (!/^[A-Z0-9]{3,20}$/.test(codigo)) return res.status(400).json({ erro: 'Código: 3 a 20 letras ou números.' });
  if (!['percentual', 'valor'].includes(tipo) || !(valor > 0)) return res.status(400).json({ erro: 'Valor do cupom inválido.' });
  if (tipo === 'percentual' && valor > MAX_CUPOM) return res.status(400).json({ erro: `Cupons acima de ${MAX_CUPOM}% não podem ser emitidos.` });
  if (get('SELECT 1 FROM cupons WHERE loja_id=? AND codigo=?', req.loja.id, codigo)) return res.status(400).json({ erro: 'Esse código já existe.' });
  run('INSERT INTO cupons(loja_id,codigo,tipo,valor) VALUES(?,?,?,?)', req.loja.id, codigo, tipo, valor); res.json({ ok: true });
});
app.delete('/api/vendedor/cupons/:id', vendedor, (req, res) => { run('DELETE FROM cupons WHERE id=? AND loja_id=?', req.params.id, req.loja.id); res.json({ ok: true }); });

// Vale-presente emitido pelo vendedor (só nos valores da lista)
app.get('/api/vendedor/vales', vendedor, (req, res) => res.json(all('SELECT * FROM vales WHERE loja_id=? ORDER BY criado DESC', req.loja.id)));
app.post('/api/vendedor/vales', vendedor, (req, res) => {
  const valor = Number(req.body.valor);
  if (!VALES.includes(valor)) return res.status(400).json({ erro: 'Valor não disponível para vale presente.' });
  const codigo = 'VP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  run('INSERT INTO vales(loja_id,codigo,valor,criado) VALUES(?,?,?,?)', req.loja.id, codigo, valor, Date.now());
  res.json({ ok: true, codigo, valor });
});

// Avisos da aba inicial (promoções / estoque)
app.post('/api/vendedor/avisos', vendedor, (req, res) => {
  const tipo = req.body.tipo === 'estoque' ? 'estoque' : 'promocao';
  if (!txt(req.body.titulo)) return res.status(400).json({ erro: 'Informe o título.' });
  run('INSERT INTO avisos(loja_id,tipo,titulo,texto,criado) VALUES(?,?,?,?,?)', req.loja.id, tipo, txt(req.body.titulo), txt(req.body.texto), Date.now());
  res.json({ ok: true });
});

app.get('/api/vendedor/pedidos', vendedor, (req, res) =>
  res.json(all(`SELECT * FROM pedidos WHERE loja_id=? ORDER BY criado ${req.query.ordem === 'antigos' ? 'ASC' : 'DESC'}`, req.loja.id)));

// Relatório: mês, bimestre, trimestre e ano (calendário atual)
function relatorio(lojaId) {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth();
  const ini = { mes: new Date(y, m, 1), bimestre: new Date(y, Math.floor(m / 2) * 2, 1),
                trimestre: new Date(y, Math.floor(m / 3) * 3, 1), ano: new Date(y, 0, 1) };
  const out = {};
  for (const [k, t] of Object.entries(ini)) {
    const r = lojaId
      ? get('SELECT COUNT(*) n, COALESCE(SUM(preco),0) total FROM pedidos WHERE loja_id=? AND criado>=?', lojaId, +t)
      : get('SELECT COUNT(*) n, COALESCE(SUM(preco),0) total FROM pedidos WHERE criado>=?', +t);
    out[k] = { vendas: r.n, total: r.total };
  }
  return out;
}
app.get('/api/vendedor/relatorio', vendedor, (req, res) => res.json(relatorio(req.loja.id)));

// ---------- 6. PEDIDOS (precisa de conta) ----------
app.post('/api/pedidos', logado, (req, res) => {
  const b = req.body; let loja_id, item, preco, produto_id = null;
  if (b.vale_valor) {                                   // compra de vale presente
    const l = get('SELECT id FROM lojas WHERE id=?', b.loja_id);
    if (!l || !VALES.includes(Number(b.vale_valor))) return res.status(400).json({ erro: 'Vale inválido.' });
    loja_id = l.id; item = `Vale presente R$ ${Number(b.vale_valor)}`; preco = Number(b.vale_valor);
  } else {
    const p = get('SELECT p.*, u.bloqueado FROM produtos p JOIN lojas l ON l.id=p.loja_id JOIN usuarios u ON u.id=l.usuario_id WHERE p.id=?', b.produto_id);
    if (!p || p.bloqueado) return res.status(404).json({ erro: 'Produto não encontrado.' });
    if (p.estoque < 1) return res.status(400).json({ erro: 'Produto sem estoque.' });
    loja_id = p.loja_id; produto_id = p.id; item = p.nome || p.classe; preco = p.preco;
  }
  if (!txt(b.nome) || !txt(b.cidade) || !txt(b.bairro) || !txt(b.rua) || !txt(b.numero)) return res.status(400).json({ erro: 'Preencha todos os campos.' });
  if (digits(b.cep).length !== 8) return res.status(400).json({ erro: 'CEP inválido.' });
  if (digits(b.telefone).length < 10) return res.status(400).json({ erro: 'Telefone inválido (DDD + número).' });
  if (!['pix', 'cartao'].includes(b.metodo)) return res.status(400).json({ erro: 'Forma de pagamento inválida.' });
  if (b.metodo === 'pix' && !ehImagem(b.comprovante)) return res.status(400).json({ erro: 'Anexe o comprovante do Pix.' });

  let desconto = 0, cupom = null;
  if (txt(b.cupom) && produto_id) {                      // cupom: nunca passa de 50% do preço
    const c = get('SELECT * FROM cupons WHERE loja_id=? AND codigo=? AND ativo=1', loja_id, txt(b.cupom).toUpperCase());
    if (!c) return res.status(400).json({ erro: 'Cupom inválido.' });
    desconto = Math.min(c.tipo === 'percentual' ? preco * c.valor / 100 : c.valor, preco * MAX_CUPOM / 100); cupom = c.codigo;
  }
  let vale = null;
  if (txt(b.vale_codigo) && produto_id) {
    vale = get('SELECT * FROM vales WHERE loja_id=? AND codigo=? AND usado=0', loja_id, txt(b.vale_codigo).toUpperCase());
    if (!vale) return res.status(400).json({ erro: 'Vale presente inválido ou já usado.' });
    desconto += Math.min(vale.valor, preco - desconto);
  }
  const final = Math.max(preco - desconto, 0);
  run(`INSERT INTO pedidos(loja_id,usuario_id,ip,produto_id,item,preco_original,desconto,preco,cupom,metodo,nome,cep,cidade,bairro,rua,numero,telefone,comprovante,criado)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    loja_id, req.u.id, req.ip, produto_id, item, preco, desconto, final, cupom, b.metodo, txt(b.nome), digits(b.cep),
    txt(b.cidade), txt(b.bairro), txt(b.rua), txt(b.numero), digits(b.telefone), ehImagem(b.comprovante) ? b.comprovante : null, Date.now());
  if (produto_id) run('UPDATE produtos SET estoque=estoque-1 WHERE id=?', produto_id);
  if (vale) run('UPDATE vales SET usado=1 WHERE id=?', vale.id);
  const l = get('SELECT whatsapp,pix FROM lojas WHERE id=?', loja_id);
  res.json({ ok: true, total: final, whatsapp: l.whatsapp, pix: l.pix });
});
app.get('/api/meus-pedidos', logado, (req, res) =>
  res.json(all('SELECT id,item,preco,metodo,criado FROM pedidos WHERE usuario_id=? ORDER BY criado DESC', req.u.id)));

// ---------- 7. PAINEL ADM (somente o e-mail do ADM) ----------
app.get('/api/admin/usuarios', admin, (req, res) =>
  res.json(all('SELECT u.id,u.email,u.papel,u.bloqueado,u.criado,l.nome AS loja FROM usuarios u LEFT JOIN lojas l ON l.usuario_id=u.id ORDER BY u.criado DESC')));
app.post('/api/admin/usuarios/:id/bloqueio', admin, (req, res) => {
  const u = get('SELECT * FROM usuarios WHERE id=?', req.params.id);
  if (!u || u.papel === 'admin') return res.status(400).json({ erro: 'Não é possível alterar este usuário.' });
  run('UPDATE usuarios SET bloqueado=? WHERE id=?', req.body.bloqueado ? 1 : 0, u.id); res.json({ ok: true });
});
app.delete('/api/admin/usuarios/:id', admin, (req, res) => {
  const u = get('SELECT * FROM usuarios WHERE id=?', req.params.id);
  if (!u || u.papel === 'admin') return res.status(400).json({ erro: 'Não é possível excluir este usuário.' });
  const l = get('SELECT id FROM lojas WHERE usuario_id=?', u.id);
  if (l) for (const t of ['produtos', 'cupons', 'vales', 'avisos', 'pedidos']) run(`DELETE FROM ${t} WHERE loja_id=?`, l.id);
  run('DELETE FROM lojas WHERE usuario_id=?', u.id);
  run('UPDATE pedidos SET usuario_id=NULL WHERE usuario_id=?', u.id);
  run('DELETE FROM usuarios WHERE id=?', u.id); res.json({ ok: true });
});
app.get('/api/admin/relatorio', admin, (req, res) => res.json(relatorio(null)));

// ---------- 8. SITE (pasta public) ----------
const PUBLIC = path.join(__dirname, 'public');
fs.mkdirSync(PUBLIC, { recursive: true });
app.use(express.static(PUBLIC));
app.get('/', (req, res) => {
  const f = path.join(PUBLIC, 'index.html');
  fs.existsSync(f) ? res.sendFile(f)
    : res.status(404).send(`<h3>index.html não encontrado</h3><p>Coloque o arquivo em:<br><b>${f}</b></p>`);
});
app.listen(process.env.PORT || 3000, () => {
  console.log('Kivra rodando em http://localhost:3000');
  console.log('index.html:', fs.existsSync(path.join(PUBLIC, 'index.html')) ? 'encontrado' : 'NÃO ENCONTRADO em ' + PUBLIC);
});
