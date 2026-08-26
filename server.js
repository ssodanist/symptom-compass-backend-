require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN, // 프론트엔드 배포 주소 (예: https://symptom-compass.com)
    credentials: true
  })
);

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET이 설정되지 않았습니다. .env 파일을 확인하세요.');
}

// ⚠️ 예시용 메모리 저장소입니다. 실서비스에서는 PostgreSQL/MySQL/MongoDB 등
//    실제 데이터베이스로 반드시 교체하세요. (서버 재시작 시 데이터가 사라집니다)
const users = new Map();

/**
 * 프론트엔드(Kakao JS SDK)에서 로그인 성공 시 받은 access_token을
 * 서버가 직접 카카오 API로 검증하고, 우리 서비스 자체 세션(JWT 쿠키)을 발급합니다.
 * → access_token을 그대로 신뢰하지 않고 서버에서 재검증하는 것이 보안상 중요합니다.
 */
app.post('/api/auth/kakao', async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) {
    return res.status(400).json({ error: 'access_token이 없습니다.' });
  }

  try {
    const kakaoRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    if (!kakaoRes.ok) {
      return res.status(401).json({ error: '카카오 토큰 검증에 실패했습니다.' });
    }

    const kakaoUser = await kakaoRes.json();
    const kakaoId = String(kakaoUser.id);
    const nickname = kakaoUser.kakao_account?.profile?.nickname || '사용자';
    const profileImage = kakaoUser.kakao_account?.profile?.profile_image_url || null;

    let user = users.get(kakaoId);
    if (!user) {
      user = {
        id: kakaoId,
        nickname,
        profileImage,
        createdAt: new Date().toISOString()
      };
      users.set(kakaoId, user);
    }

    const sessionToken = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });

    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: true, // 배포 환경(HTTPS)에서만 true로 동작 — 로컬 http 테스트 시 false로 임시 변경
      sameSite: 'none',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.json({ user });
  } catch (err) {
    console.error('카카오 로그인 처리 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 현재 로그인 상태 확인 (프론트엔드가 새로고침 시 호출)
app.get('/api/me', (req, res) => {
  const token = req.cookies.session;
  if (!token) return res.status(401).json({ user: null });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = users.get(payload.uid) || null;
    res.json({ user });
  } catch {
    res.status(401).json({ user: null });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
