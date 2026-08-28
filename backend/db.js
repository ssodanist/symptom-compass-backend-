const { Pool } = require('pg');

// DATABASE_URL은 Supabase 프로젝트의 "Connection string(URI)"입니다.
// 설정 방법은 SUPABASE-SETUP.md를 참고하세요.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false } // Supabase는 SSL 연결이 필수예요.
    })
  : null;

if (!pool) {
  console.warn('⚠️  DATABASE_URL이 설정되지 않았습니다. 로그인/회원 기능이 동작하지 않습니다.');
}

// DB의 snake_case 컬럼을 프론트엔드가 쓰는 camelCase 형태로 변환합니다.
function toUserJSON(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    nickname: row.nickname,
    profileImage: row.profile_image,
    createdAt: row.created_at
  };
}

async function findUserById(id) {
  if (!pool) throw new Error('DATABASE_URL이 설정되지 않았습니다.');
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return toUserJSON(rows[0]);
}

// 로그인할 때마다 호출: 없으면 새로 만들고, 있으면 닉네임·프로필사진을 최신값으로 갱신합니다.
async function upsertUser({ id, provider, nickname, profileImage }) {
  if (!pool) throw new Error('DATABASE_URL이 설정되지 않았습니다.');
  const { rows } = await pool.query(
    `INSERT INTO users (id, provider, nickname, profile_image)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET nickname = EXCLUDED.nickname,
           profile_image = EXCLUDED.profile_image
     RETURNING *`,
    [id, provider, nickname, profileImage]
  );
  return toUserJSON(rows[0]);
}

async function deleteUser(id) {
  if (!pool) throw new Error('DATABASE_URL이 설정되지 않았습니다.');
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}

module.exports = { findUserById, upsertUser, deleteUser };
