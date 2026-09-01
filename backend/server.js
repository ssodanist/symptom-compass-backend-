require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const db = require('./db');

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

function issueSession(res, user) {
  const sessionToken = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('session', sessionToken, {
    httpOnly: true,
    secure: true, // 배포 환경(HTTPS)에서만 true로 동작 — 로컬 http 테스트 시 false로 임시 변경
    sameSite: 'none',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

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
    const id = `kakao:${kakaoUser.id}`;
    const nickname = kakaoUser.kakao_account?.profile?.nickname || '사용자';
    const
