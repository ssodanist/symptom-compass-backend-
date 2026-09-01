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
    const profileImage = kakaoUser.kakao_account?.profile?.profile_image_url || null;

    const user = await db.upsertUser({ id, provider: 'kakao', nickname, profileImage });

    issueSession(res, user);
    res.json({ user });
  } catch (err) {
    console.error('카카오 로그인 처리 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

/**
 * 네이버 로그인도 동일한 패턴입니다: 프론트엔드(네이버 JS SDK)가 팝업 로그인 후 받은
 * access_token을 서버가 다시 네이버 API(openapi.naver.com)로 검증합니다.
 */
app.post('/api/auth/naver', async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) {
    return res.status(400).json({ error: 'access_token이 없습니다.' });
  }

  try {
    const naverRes = await fetch('https://openapi.naver.com/v1/nid/me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    if (!naverRes.ok) {
      return res.status(401).json({ error: '네이버 토큰 검증에 실패했습니다.' });
    }

    const naverJson = await naverRes.json();
    if (naverJson.resultcode !== '00' || !naverJson.response) {
      return res.status(401).json({ error: '네이버 사용자 정보를 가져오지 못했습니다.' });
    }

    const profile = naverJson.response;
    const id = `naver:${profile.id}`;
    const nickname = profile.nickname || profile.name || '사용자';
    const profileImage = profile.profile_image || null;

    const user = await db.upsertUser({ id, provider: 'naver', nickname, profileImage });

    issueSession(res, user);
    res.json({ user });
  } catch (err) {
    console.error('네이버 로그인 처리 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 현재 로그인 상태 확인 (프론트엔드가 새로고침 시 호출)
app.get('/api/me', async (req, res) => {
  const token = req.cookies.session;
  if (!token) return res.status(401).json({ user: null });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.findUserById(payload.uid);
    res.json({ user });
  } catch {
    res.status(401).json({ user: null });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

// 회원 탈퇴: 로그인된 사용자 본인의 계정을 즉시 삭제합니다.
app.delete('/api/account', async (req, res) => {
  const token = req.cookies.session;
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다.' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    await db.deleteUser(payload.uid);
    res.clearCookie('session');
    res.json({ ok: true });
  } catch (err) {
    console.error('회원 탈퇴 처리 오류:', err);
    res.status(401).json({ error: '로그인이 필요합니다.' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

/* ===================== 알약 식별 (식품의약품안전처 낱알식별정보) =====================
   데이터 출처: 공공데이터포털 "식품의약품안전처_의약품 낱알식별 정보"
   https://www.data.go.kr/data/15057639/openapi.do
   ⚠️ 발급받으실 때 "Decoding" 키를 DATA_GO_KR_KEY에 넣으세요.
   ⚠️ 파라미터명(drug_shape, print_front 등)은 문서 버전에 따라 다를 수 있어요.
      키 발급 후 바로 테스트해보시고, 결과가 이상하면 원인을 같이 찾아드릴게요. */
app.get('/api/pills', async (req, res) => {
  if (!process.env.DATA_GO_KR_KEY) {
    return res.status(500).json({ error: 'DATA_GO_KR_KEY가 설정되지 않았어요. .env를 확인해주세요.' });
  }

  const { shape, color, frontMark, backMark, name } = req.query;
  if (!shape && !color && !frontMark && !backMark && !name) {
    return res.status(400).json({ error: '모양·색상·각인·이름 중 최소 하나는 입력해주세요.' });
  }

  try {
    const params = new URLSearchParams({
      serviceKey: process.env.DATA_GO_KR_KEY,
      pageNo: '1',
      numOfRows: '100',
      type: 'json'
    });
    if (shape) params.set('drug_shape', shape);
    if (color) params.set('color_class1', color);
    if (frontMark) params.set('print_front', frontMark);
    if (backMark) params.set('print_back', backMark);
    if (name) params.set('item_name', name);

    const url = `https://apis.data.go.kr/1471000/MdcinGrnIdntfcInfoService01/getMdcinGrnIdntfcInfoList01?${params.toString()}`;
    const apiRes = await fetch(url);
    const data = await apiRes.json();

    const header = data?.body?.items ? null : data?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      console.error('낱알식별 API 오류:', header);
      return res.status(502).json({ error: `API 오류: ${header.resultMsg || header.resultCode}` });
    }

    let items = data?.body?.items || [];
    if (!Array.isArray(items)) items = [items];

    const pills = items.slice(0, 20).map(it => ({
      name: it.ITEM_NAME,
      entpName: it.ENTP_NAME,
      shape: it.DRUG_SHAPE,
      color1: it.COLOR_CLASS1,
      color2: it.COLOR_CLASS2 || null,
      frontMark: it.PRINT_FRONT || null,
      backMark: it.PRINT_BACK || null,
      formName: it.FORM_CODE_NAME || null,
      image: it.ITEM_IMAGE || null
    }));

    res.json({ pills });
  } catch (err) {
    console.error('낱알식별 조회 오류:', err);
    res.status(500).json({ error: '약 정보를 불러오는 중 오류가 발생했어요.' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
