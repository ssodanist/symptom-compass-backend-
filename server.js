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

   ⚠️ 중요: 이 API는 모양·색상·각인으로 "검색"하는 요청 파라미터를 제공하지 않아요.
   검색 가능한 요청 파라미터는 item_name(품목명), entp_name(업체명), item_seq, edi_code, bizrno 뿐입니다.
   모양·색상·각인 정보는 "응답 결과" 안에는 들어있어서, 넉넉히 데이터를 받아온 뒤
   우리 서버에서 직접 대조해서 걸러내는 방식으로 구현했습니다.
   → 품목명 없이 모양·색상·각인만으로 검색하면, 정부 API가 한 번에 주는 데이터(최대 100건)
      안에서만 찾기 때문에 결과가 안 나올 수 있어요. 이름을 조금이라도 아시면 같이 입력해주세요. */
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
      numOfRows: '100', // 이 API가 실제 지원하는 요청 파라미터는 item_name/entp_name/item_seq/edi_code/bizrno 뿐입니다.
      type: 'json'
    });
    if (name) params.set('item_name', name);

    const url = `https://apis.data.go.kr/1471000/MdcinGrnIdntfcInfoService03/getMdcinGrnIdntfcInfoList03?${params.toString()}`;
    const apiRes = await fetch(url);
    const data = await apiRes.json();

    const header = data?.body?.items ? null : data?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      console.error('낱알식별 API 오류:', header);
      return res.status(502).json({ error: `API 오류: ${header.resultMsg || header.resultCode}` });
    }

    let items = data?.body?.items || [];
    if (!Array.isArray(items)) items = [items];

    // 모양·색상·각인은 응답 데이터를 우리 서버에서 직접 대조해서 걸러냅니다.
    items = items.filter(it => {
      if (shape && it.DRUG_SHAPE !== shape) return false;
      if (color) {
        const c1 = it.COLOR_CLASS1 || '';
        const c2 = it.COLOR_CLASS2 || '';
        if (!c1.includes(color) && !c2.includes(color)) return false;
      }
      if (frontMark && !(it.PRINT_FRONT || '').toUpperCase().includes(frontMark.toUpperCase())) return false;
      if (backMark && !(it.PRINT_BACK || '').toUpperCase().includes(backMark.toUpperCase())) return false;
      return true;
    });

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

/* ===================== 약 이름으로 효능·용법·주의사항 검색 (e약은요) =====================
   데이터 출처: 공공데이터포털 "식품의약품안전처_의약품개요정보(e약은요)"
   https://www.data.go.kr/data/15075057/openapi.do
   이름으로 검색해서 일반인이 이해하기 쉬운 문장으로 효능·용법·주의사항 등을 제공합니다. */
app.get('/api/drug-info', async (req, res) => {
  if (!process.env.DATA_GO_KR_KEY) {
    return res.status(500).json({ error: 'DATA_GO_KR_KEY가 설정되지 않았어요. .env를 확인해주세요.' });
  }

  const { name } = req.query;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '약 이름을 입력해주세요.' });
  }

  try {
    const params = new URLSearchParams({
      serviceKey: process.env.DATA_GO_KR_KEY,
      pageNo: '1',
      numOfRows: '10',
      type: 'json',
      itemName: name.trim()
    });

    const url = `https://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList?${params.toString()}`;
    const apiRes = await fetch(url);
    const data = await apiRes.json();

    const header = data?.body?.items ? null : data?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      console.error('e약은요 API 오류:', header);
      return res.status(502).json({ error: `API 오류: ${header.resultMsg || header.resultCode}` });
    }

    let items = data?.body?.items || [];
    if (!Array.isArray(items)) items = [items];

    const drugs = items.slice(0, 10).map(it => ({
      name: it.itemName,
      entpName: it.entpName,
      image: it.itemImage || null,
      efficacy: it.efcyQesitm || null,       // 효능효과
      usage: it.useMethodQesitm || null,     // 용법용량
      caution: it.atpnQesitm || null,        // 주의사항 (일반)
      cautionWarn: it.atpnWarnQesitm || null,// 주의사항 (경고)
      interaction: it.intrcQesitm || null,   // 상호작용
      sideEffect: it.seQesitm || null,       // 부작용
      storage: it.depositMethodQesitm || null // 보관법
    }));

    res.json({ drugs });
  } catch (err) {
    console.error('약 정보 조회 오류:', err);
    res.status(500).json({ error: '약 정보를 불러오는 중 오류가 발생했어요.' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
