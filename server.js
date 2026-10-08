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