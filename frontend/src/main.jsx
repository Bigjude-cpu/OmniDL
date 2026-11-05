import { apiUrl } from "./api-url.js";
import FormatSelect from "./FormatSelect.jsx";
import MediaPreview from "./MediaPreview.jsx";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowRight,
  Link,
  Check,
  LoaderCircle,
  Music2,
  Video,
  Image as ImageIcon,
  X,
  Download,
  Layers,
  AlertCircle,
} from "lucide-react";
import "./styles.css";
const duration = (s) =>
  s
    ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
    : null;
async function api(path, body) {
  const response = await fetch(apiUrl("/api/v1/media/" + path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Error(data.error || "The server could not complete your request.");
  }
  return response;
}
function App() {
  const [url, setUrl] = useState(""),
    [media, setMedia] = useState(null),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [selected, setSelected] = useState([]),
    [formats, setFormats] = useState({});
  async function analyze(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");
    setMedia(null);
    try {
      const result = await (await api("analyze", { url: url.trim() })).json();
      setMedia(result);
      setSelected(result.items.map((i) => i.id));
      setFormats(
        Object.fromEntries(result.items.map((i) => [i.id, i.formats[0].id])),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  async function download(ids, archive = false) {
    setBusy(true);
    setError("");
    setNotice("Preparing your download…");
    try {
      const response = await api("download", {
        mediaId: media.id,
        selections: ids.map((itemId) => ({
          itemId,
          formatId: formats[itemId],
        })),
        archive,
      });
      const blob = await response.blob(),
        href = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = href;
      a.download =
        archive || ids.length > 1
          ? "Crazibox.zip"
          : `Crazibox.${media.items.find((i) => i.id === ids[0]).formats.find((f) => f.id === formats[ids[0]]).extension}`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60000);
      setNotice("Your download is ready. Check your downloads folder.");
    } catch (e) {
      setNotice("");
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="shell">
      <header>
        <a className="brand" href="/" aria-label="Crazibox home">
          <span className="brand-icon">
            <ArrowDown size={20} />
          </span>
          Crazi<span>box</span>
        </a>
        <span className="tagline">Paste. Detect. Download.</span>
      </header>
      <main>
        <section className="intro">
          <span className="eyebrow">ONE LINK. YOUR MEDIA.</span>
          <h1>
            Download media
            <br className="mobile-break" /> from one link.
          </h1>
          <p>Videos, audio, and images. In their best available quality.</p>
        </section>
        <form onSubmit={analyze}>
          <div className="url-box">
            <Link size={20} aria-hidden="true" />
            <input
              aria-label="Media URL"
              type="url"
              required
              placeholder="Paste media URL…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading || busy}
            />
            {url && !loading && !busy && (
              <button
                className="clear"
                type="button"
                aria-label="Clear URL"
                onClick={() => setUrl("")}
              >
                <X size={17} />
              </button>
            )}
            <button
              className="analyze"
              type="submit"
              disabled={loading || busy || !url.trim()}
              aria-label="Analyze URL"
            >
              {loading ? (
                <LoaderCircle className="spin" size={21} />
              ) : (
                <ArrowRight size={22} />
              )}
            </button>
          </div>
        </form>
        <div className="supported">
          <span>TikTok</span>
          <b>•</b>
          <span>Instagram</span>
          <b>•</b>
          <span>YouTube</span>
          <b>•</b>
          <span>Pinterest</span>
          <b>•</b>
          <span>Facebook</span>
          <b>•</b>
          <span>X / Twitter</span>
          <span className="auto">
            <Check size={13} /> Automatically detected
          </span>
        </div>
        {error && (
          <div className="message error" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="message success" role="status">
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <Check size={18} />
            )}
            <span>{notice}</span>
          </div>
        )}
        {loading && (
          <section className="loading" role="status">
            <div className="skeleton" />
            <div>
              <div className="skeleton line" />
              <div className="skeleton line short" />
              <p>
                <LoaderCircle className="spin" size={16} /> Detecting your
                media…
              </p>
              <small>This can take up to two minutes.</small>
            </div>
          </section>
        )}
        {media && (
          <section className="result" aria-label="Media result">
            <div className="post-heading">
              <div className="post-identity">
                <span className="post-username">
                  {media.username
                    ? `@${media.username}`
                    : media.creator || "Unknown creator"}
                </span>
                <span className="platform">{media.platform}</span>
              </div>
              {(media.caption ?? media.title) && (
                <h2 className="post-caption">{media.caption ?? media.title}</h2>
              )}
              {media.hashtags?.length > 0 && (
                <div className="post-hashtags" aria-label="Hashtags">
                  {media.hashtags.map((tag) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                </div>
              )}
              {media.items.length > 1 && (
                <div className="post-count">
                  {media.items.length} items ·{" "}
                  {media.type === "mixed"
                    ? "Mixed carousel"
                    : "Image slideshow"}
                </div>
              )}
            </div>
            <div
              className={media.items.length > 1 ? "media-grid" : "media-single"}
            >
              {media.items.map((item, index) => {
                const current = item.formats.find(
                  (f) => f.id === formats[item.id],
                );
                return (
                  <article
                    className={`media-item ${item.type}-item`}
                    key={item.id}
                  >
                    <div className="preview">
                      <MediaPreview item={item} index={index} />
                      {item.duration && (
                        <span className="duration">
                          {duration(item.duration)}
                        </span>
                      )}
                      {media.items.length > 1 && (
                        <label className="selection">
                          <input
                            type="checkbox"
                            checked={selected.includes(item.id)}
                            onChange={(e) =>
                              setSelected(
                                e.target.checked
                                  ? [...selected, item.id]
                                  : selected.filter((id) => id !== item.id),
                              )
                            }
                            aria-label={`Select item ${index + 1}`}
                          />
                          <span>{String(index + 1).padStart(2, "0")}</span>
                        </label>
                      )}
                    </div>
                    <div className="item-controls">
                      {item.type === "video" ? (
                        <>
                          <div
                            className="tabs"
                            role="group"
                            aria-label={`Download type for item ${index + 1}`}
                          >
                            {["video", "audio"]
                              .filter((kind) =>
                                item.formats.some((f) => f.kind === kind),
                              )
                              .map((kind) => (
                                <button
                                  key={kind}
                                  aria-pressed={current.kind === kind}
                                  onClick={() =>
                                    setFormats({
                                      ...formats,
                                      [item.id]: item.formats.find(
                                        (f) => f.kind === kind,
                                      ).id,
                                    })
                                  }
                                >
                                  {kind === "video" ? (
                                    <Video size={16} />
                                  ) : (
                                    <Music2 size={16} />
                                  )}{" "}
                                  {kind === "video" ? "Video" : "Audio"}
                                </button>
                              ))}
                          </div>
                          <label
                            className="format-label"
                            htmlFor={"format-" + item.id}
                          >
                            {current.kind === "video"
                              ? "Quality"
                              : "Audio format"}
                          </label>
                          <FormatSelect
                            id={"format-" + item.id}
                            value={current.id}
                            onChange={(e) =>
                              setFormats({
                                ...formats,
                                [item.id]: e.target.value,
                              })
                            }
                          >
                            {item.formats
                              .filter((f) => f.kind === current.kind)
                              .map((f, n) => (
                                <option value={f.id} key={f.id}>
                                  {f.label}
                                  {f.kind === "video"
                                    ? ` · MP4${n === 0 ? " · Best available" : ""}`
                                    : ""}
                                </option>
                              ))}
                          </FormatSelect>
                        </>
                      ) : media.items.length === 1 ? (
                        <>
                          <label
                            className="format-label"
                            htmlFor={"format-" + item.id}
                          >
                            Image format
                          </label>
                          <FormatSelect
                            id={"format-" + item.id}
                            value={current.id}
                            onChange={(e) =>
                              setFormats({
                                ...formats,
                                [item.id]: e.target.value,
                              })
                            }
                          >
                            {item.formats.map((format) => (
                              <option key={format.id} value={format.id}>
                                {format.label}
                              </option>
                            ))}
                          </FormatSelect>
                        </>
                      ) : null}
                      <button
                        className="download"
                        disabled={busy}
                        onClick={() => download([item.id])}
                      >
                        <Download size={17} />
                        {busy
                          ? "Preparing…"
                          : `Download ${current.extension.toUpperCase()}`}
                      </button>
                      <small
                        className={`quality-note ${media.items.length > 1 && item.type === "image" ? "hide-carousel-note" : ""}`}
                      >
                        {item.type === "image"
                          ? "Full resolution. Converted to your selected format."
                          : "Source quality preserved. No watermark editing."}
                      </small>
                    </div>
                  </article>
                );
              })}
            </div>
            {media.items.length > 1 && (
              <div className="batch">
                <span>
                  {selected.length} of {media.items.length} selected
                </span>
                {media.items.some((item) => item.type === "image") && (
                  <div className="batch-format">
                    <span>Image format</span>
                    <FormatSelect
                      aria-label="Format for all images"
                      disabled={busy}
                      value={(() => {
                        const image = media.items.find(
                          (item) => item.type === "image",
                        );
                        return image.formats.find(
                          (format) => format.id === formats[image.id],
                        ).extension;
                      })()}
                      onChange={(event) => {
                        const extension = event.target.value;
                        setFormats((previous) => ({
                          ...previous,
                          ...Object.fromEntries(
                            media.items
                              .filter((item) => item.type === "image")
                              .map((item) => [
                                item.id,
                                item.formats.find(
                                  (format) => format.extension === extension,
                                ).id,
                              ]),
                          ),
                        }));
                      }}
                    >
                      {["png", "jpg", "jpeg", "webp"].map((extension) => (
                        <option key={extension} value={extension}>
                          {extension.toUpperCase()}
                        </option>
                      ))}
                    </FormatSelect>
                  </div>
                )}
                <button
                  className="secondary"
                  disabled={busy || !selected.length}
                  onClick={() => download(selected, true)}
                >
                  Download selected
                </button>
                <button
                  className="download"
                  disabled={busy}
                  onClick={() =>
                    download(
                      media.items.map((i) => i.id),
                      true,
                    )
                  }
                >
                  <Layers size={17} />
                  Download all · ZIP
                </button>
              </div>
            )}
          </section>
        )}
        {!media && !loading && (
          <div className="empty">
            <span className="empty-icon">
              <Link size={24} />
            </span>
            <h2>Your next download starts here.</h2>
            <p>Paste a link above. We’ll take care of the formats.</p>
            <div className="media-types">
              <span>
                <Video size={15} />
                Video
              </span>
              <span>
                <Music2 size={15} />
                Audio
              </span>
              <span>
                <ImageIcon size={15} />
                Images
              </span>
            </div>
          </div>
        )}
        <footer>
          <span>Only download media you own or have permission to use.</span>
          <span>No account. No permanent media storage.</span>
          <span className="footer-credit">
            Made by{" "}
            <a
              href="https://github.com/DzarelDeveloper"
              target="_blank"
              rel="noopener noreferrer"
            >
              Dzarel Alghifari
            </a>
            <span aria-hidden="true" className="credit-separator">
              ·
            </span>
            <a
              href="https://github.com/DzarelDeveloper/OmniDL"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="OmniDL source on GitHub (opens in a new tab)"
            >
              GitHub ↗
            </a>
          </span>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
