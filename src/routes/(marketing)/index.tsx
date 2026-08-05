import { Link, createFileRoute } from '@tanstack/react-router';
import { useIntlayer } from 'react-intlayer';
import '~/styles/marketing-home.css';

export const Route = createFileRoute('/(marketing)/')({
  component: RouteComponent,
});

const GH = 'https://github.com/deeptoai-com/kin';
const GH_DEPLOY = 'https://github.com/deeptoai-com/kin/blob/main/docs/deployment/mac-mini.md';

/* Low-density, image-led layout (Cursor-style): one idea per scroll —
   short heading + one line + a big visual. Replace the mock visuals with the
   screenshot/GIF assets listed in docs/gtm/media-checklist.md before GTM. */
function RouteComponent() {
  const c = useIntlayer('home');

  return (
    <div className="oxy-home">
      {/* ── Hero: headline + one line + CTA + ONE big visual ──── */}
      <section className="hero" id="top">
        <div className="wrap">
          <div className="tag">
            $ kin up —— <b>self-hosted</b> · any-model · sandboxed · Apache-2.0
          </div>
          <h1>
            <span className="soft">{c.hero.titleSoft}</span>
            <br />
            {c.hero.titleMain}
            <span className="cl">{c.hero.titleAccent}</span>
            <i className="cur" />
          </h1>
          <p className="hero-sub">{c.hero.subtitleStrong}</p>
          <div className="hero-cta">
            <Link className="btn-go" to="/agents/c">
              {c.hero.ctaPrimary} <span className="ar">→</span>
            </Link>
            <a className="btn-ghost" href={GH} target="_blank" rel="noopener noreferrer">
              {c.hero.ctaSecondary}
            </a>
          </div>
        </div>

        {/* big hero visual — a real-looking product mock */}
        <div className="wrap">
          <div className="app heroapp">
            <div className="app-top">
              <div className="l">
                <span className="cl">~/</span>kin<span style={{ color: 'var(--line-2)' }}>/</span>
                <b>agents/c</b>
              </div>
              <div className="st">
                <i /> model: glm · any provider · live
              </div>
            </div>
            <div className="app-body">
              <aside className="side">
                <div className="cap">sessions</div>
                <div className="sess on">
                  refactor landing<span className="w">running</span>
                </div>
                <div className="sess">
                  wire internal API<span className="w">resumed</span>
                </div>
                <div className="sess">
                  data-clean script<span className="w">2h ago</span>
                </div>
                <div className="sess">
                  weekly digest<span className="w">yesterday</span>
                </div>
              </aside>

              <div className="chat">
                <span className="eyebrow">
                  <b>session</b> · refactor landing
                </span>
                <div className="bubble user">
                  <div className="who">you</div>
                  <div className="tx">Reskin the landing, then build.</div>
                </div>
                <div className="bubble ai">
                  <div className="who">kin · glm</div>
                  <div className="tx">On it — updating design tokens and verifying the build —</div>
                </div>
                <div className="term">
                  <div className="bar">
                    <i className="r" />
                    <i />
                    <i /> &nbsp;bash · sandbox
                  </div>
                  <div className="body">
                    <span className="c"># runs in an isolated sandbox</span>
                    <br />
                    <span className="k">$</span> pnpm build
                    <br />
                    <span className="g">✓</span> built in 6.2s · 0 errors
                    <br />
                    <span className="k">$</span> <span className="tcur" />
                  </div>
                </div>
              </div>

              <aside className="rail">
                <div className="cap">output</div>
                <div className="deliv ok">
                  <span className="s">[ done ]</span>
                  <div className="tx">design tokens updated</div>
                </div>
                <div className="deliv now">
                  <span className="s">[ live ]</span>
                  <div className="tx">preview · index.html</div>
                </div>
                <div className="deliv">
                  <span className="s wait">[ todo ]</span>
                  <div className="tx">deploy to kin.local</div>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </section>

      {/* ── Trust strip ───────────────────────────────────────── */}
      <section className="trust">
        <div className="wrap">
          <div className="cap">// works with any model · built on open standards</div>
          <div className="row">
            <b>GLM</b> <span className="dot">·</span> <b>DeepSeek</b> <span className="dot">·</span>{' '}
            <b>GPT</b> <span className="dot">·</span> <b>Qwen</b> <span className="dot">·</span> MCP{' '}
            <span className="dot">·</span> Skills <span className="dot">·</span> Kin Agent
          </div>
        </div>
      </section>

      {/* ── Feature rows: one idea per scroll, big image, low text ── */}
      <section className="fsec">
        <div className="wrap">
          <div className="frow">
            <div className="ftext">
              <span className="eyebrow">
                <b>[01]</b> private
              </span>
              <h2>{c.concept.p1Title}</h2>
              <p>{c.concept.p1Desc}</p>
            </div>
            <div className="shot">
              <span className="ph">screenshot · 自部署 · 团队登录</span>
            </div>
          </div>
        </div>
      </section>

      <section className="fsec">
        <div className="wrap">
          <div className="frow rev">
            <div className="shot">
              <span className="ph">screenshot · 共享 Project · 团队协作</span>
            </div>
            <div className="ftext">
              <span className="eyebrow">
                <b>[02]</b> co-work
              </span>
              <h2>{c.feat.coworkTitle}</h2>
              <p>{c.feat.coworkDesc}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="fsec dark">
        <div className="wrap">
          <div className="frow">
            <div className="ftext">
              <span className="eyebrow">
                <b>[03]</b> rag
              </span>
              <h2>{c.feat.ragTitle}</h2>
              <p>{c.feat.ragDesc}</p>
            </div>
            <div className="shot">
              <span className="ph">screenshot · 知识库 · 向量检索</span>
            </div>
          </div>
        </div>
      </section>

      <section className="fsec">
        <div className="wrap">
          <div className="frow rev">
            <div className="shot">
              <span className="ph">screenshot · OCR · 复杂 PDF / 表格识别</span>
            </div>
            <div className="ftext">
              <span className="eyebrow">
                <b>[04]</b> plugins
              </span>
              <h2>{c.feat.pluginTitle}</h2>
              <p>{c.feat.pluginDesc}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="fsec">
        <div className="wrap">
          <div className="frow">
            <div className="ftext">
              <span className="eyebrow">
                <b>[05]</b> live preview
              </span>
              <h2>{c.feat.previewTitle}</h2>
              <p>{c.feat.previewDesc}</p>
            </div>
            <div className="shot">
              <span className="ph">screenshot · React+Vite 沙盒 · 公网分享</span>
            </div>
          </div>
        </div>
      </section>

      <section className="fsec dark">
        <div className="wrap">
          <div className="frow rev">
            <div className="shot">
              <span className="ph">screenshot · 模型选择 / 健康看板</span>
            </div>
            <div className="ftext">
              <span className="eyebrow">
                <b>[06]</b> any model
              </span>
              <h2>{c.concept.p2Title}</h2>
              <p>{c.concept.p2Desc}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Who it's for ──────────────────────────────────────── */}
      <section className="icp" id="who">
        <div className="wrap">
          <span className="eyebrow">
            <b>[07]</b> who it's for
          </span>
          <h2>
            {c.icp.heading}
            <span className="cl">{c.icp.headingAccent}</span>
          </h2>
          <p className="lede">{c.icp.lede}</p>
          <div className="igrid">
            <div className="icard">
              <div className="ic">01</div>
              <h3>{c.icp.c1Title}</h3>
              <p>{c.icp.c1Desc}</p>
            </div>
            <div className="icard">
              <div className="ic">02</div>
              <h3>{c.icp.c2Title}</h3>
              <p>{c.icp.c2Desc}</p>
            </div>
            <div className="icard">
              <div className="ic">03</div>
              <h3>{c.icp.c3Title}</h3>
              <p>{c.icp.c3Desc}</p>
            </div>
            <div className="icard">
              <div className="ic">04</div>
              <h3>{c.icp.c4Title}</h3>
              <p>{c.icp.c4Desc}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Deploy ────────────────────────────────────────────── */}
      <section className="deploy" id="deploy">
        <div className="wrap">
          <div className="lead">
            <div>
              <span className="eyebrow">
                <b>[08]</b> deploy
              </span>
              <h2>
                {c.deploy.heading}
                <span className="cl">{c.deploy.headingAccent}</span>
                {c.deploy.headingTail}
              </h2>
              <p>{c.deploy.body}</p>
              <div className="hero-cta">
                <a className="btn-go" href={GH_DEPLOY} target="_blank" rel="noopener noreferrer">
                  {c.deploy.ctaPrimary} <span className="ar">→</span>
                </a>
                <a className="btn-ghost" href={GH} target="_blank" rel="noopener noreferrer">
                  {c.deploy.ctaSecondary}
                </a>
              </div>
            </div>
            <div className="term light">
              <div className="bar">
                <i className="r" />
                <i style={{ background: '#3a3833' }} />
                <i style={{ background: '#3a3833' }} /> &nbsp;deploy.sh
              </div>
              <div className="body">
                <span className="c"># fresh VPS to trusted HTTPS</span>
                <br />
                <span className="k">$</span> git clone https://github.com/deeptoai-com/kin.git
                <br />
                <span className="k">$</span> cd kin
                <br />
                <span className="k">$</span> sudo bash scripts/install-vps.sh
                <br />
                <span className="g">✓</span> kin up · TLS · preview wildcard
                <br />
                <span className="k">$</span> <span className="tcur" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────── */}
      <footer className="foot">
        <div className="wrap">
          <div className="big">
            {c.footer.bigPre}
            <span className="cl">{c.footer.bigAccent}</span>
            <i className="cur" />
          </div>
          <div className="foot-cta">
            <Link className="btn-go" to="/agents/c">
              {c.hero.ctaPrimary} <span className="ar">→</span>
            </Link>
            <a className="btn-ghost" href={GH} target="_blank" rel="noopener noreferrer">
              {c.hero.ctaSecondary}
            </a>
          </div>
          <div className="frow">
            <div className="fmeta">
              <b>Kin</b> · self-hosted AI-Agent workspace
              <br />
              single-org · multi-user · fully-sandboxed · provider-agnostic
              <br />
              Apache-2.0 open core · deeptoai · 2026
            </div>
            <a className="nbtn" href="#top">
              ↑ top
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
