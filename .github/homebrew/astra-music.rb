cask "astra-music" do
  version "0.5.2"
  sha256 "53df4c78c0779c2edc7555cec83400bd61347a5ffd20399e09cb21bc2b4c5f11"

  url "https://github.com/Boof2015/astra/releases/download/v#{version}-beta/Astra-#{version}-beta-Mac-arm64.dmg",
      verified: "github.com/Boof2015/astra/"
  name "Astra"
  desc "Music player with gapless playback, parametric EQ, and real-time DSP visualizers"
  homepage "https://astramusic.dev/"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64

  app "Astra.app"

  zap trash: [
    "~/Library/Application Support/Astra",
    "~/Library/Caches/com.astra.musicplayer",
    "~/Library/Logs/Astra",
    "~/Library/Preferences/com.astra.musicplayer.plist",
  ]
end
