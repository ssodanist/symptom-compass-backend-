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

function toHealthProfileJSON(row) {
  if (!row) return null;
  return {
    bloodType: row.blood_type,
    allergies: row.allergies,
    medications: row.medications,
    conditions: row.conditions,
    emergencyContactName: row.emergency_contact_name,
    emergencyContactPhone: row.emergency_contact_phone,
    birthYear: row.birth_year,
    gender: row.gender,
    updatedAt: row.updated_at
  };
}

async function getHealthProfile(userId) {
  if (!pool) throw new Error('DATABASE_URL이 설정되지 않았습니다.');
  const { rows } = await pool.query('SELECT * FROM health_profiles WHERE user_id = $1', [userId]);
  return toHealthProfileJSON(rows[0]);
}

// 넘어온 필드만 반영합니다 (부분 저장 가능 — 예: 건강검진 화면에서는 birth_year/gender만 저장).
async function upsertHealthProfile(userId, fields) {
  if (!pool) throw new Error('DATABASE_URL이 설정되지 않았습니다.');
  const existing = await getHealthProfile(userId);

  const merged = {
    blood_type: fields.bloodType !== undefined ? fields.bloodType : (existing?.bloodType ?? null),
    allergies: fields.allergies !== undefined ? fields.allergies : (existing?.allergies ?? null),
    medications: fields.medications !== undefined ? fields.medications : (existing?.medications ?? null),
    conditions: fields.conditions !== undefined ? fields.conditions : (existing?.conditions ?? null),
    emergency_contact_name: fields.emergencyContactName !== undefined ? fields.emergencyContactName : (existing?.emergencyContactName ?? null),
    emergency_contact_phone: fields.emergencyContactPhone !== undefined ? fields.emergencyContactPhone : (existing?.emergencyContactPhone ?? null),
    birth_year: fields.birthYear !== undefined ? fields.birthYear : (existing?.birthYear ?? null),
    gender: fields.gender !== undefined ? fields.gender : (existing?.gender ?? null)
  };

  const { rows } = await pool.query(
    `INSERT INTO health_profiles (user_id, blood_type, allergies, medications, conditions, emergency_contact_name, emergency_contact_phone, birth_year, gender, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (user_id) DO UPDATE
       SET blood_type = EXCLUDED.blood_type,
           allergies = EXCLUDED.allergies,
           medications = EXCLUDED.medications,
           conditions = EXCLUDED.conditions,
           emergency_contact_name = EXCLUDED.emergency_contact_name,
           emergency_contact_phone = EXCLUDED.emergency_contact_phone,
           birth_year = EXCLUDED.birth_year,
           gender = EXCLUDED.gender,
           updated_at = now()
     RETURNING *`,
    [userId, merged.blood_type, merged.allergies, merged.medications, merged.conditions,
     merged.emergency_contact_name, merged.emergency_contact_phone, merged.birth_year, merged.gender]
  );
  return toHealthProfileJSON(rows[0]);
}

module.exports = { findUserById, upsertUser, deleteUser, getHealthProfile, upsertHealthProfile };
