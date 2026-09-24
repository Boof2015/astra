import type { HomePlaybackSourceSummary } from '../../../types/home'
import HomeSection from './HomeSection'
import HomeExpandableGrid from './HomeExpandableGrid'
import { HomeCollectionCard } from './HomeMediaCards'
import { HomeLoadingCollectionGrid } from './HomeLoadingCards'
import type { HomePlaybackControlState } from './HomePlaybackControl'

export type JumpBackInCard = HomePlaybackSourceSummary & { active: boolean }

export default function HomeJumpBackIn({ cards, loading = false, getPlayback, onOpen, onPlay }: {
  cards: readonly JumpBackInCard[]
  loading?: boolean
  getPlayback: (card: JumpBackInCard) => HomePlaybackControlState
  onOpen: (card: JumpBackInCard) => void
  onPlay: (card: JumpBackInCard) => void
}) {
  if (!cards.length && !loading) return null
  return (
    <HomeSection id="jump-back-in" title="Jump back in">
      {loading ? <HomeLoadingCollectionGrid /> : (
        <HomeExpandableGrid items={cards} getKey={(card) => card.key} renderItem={(card) => (
          <HomeCollectionCard hoverPlayback title={card.title} subtitle={<>{card.subtitle} · <span>{card.detail}</span></>}
            artworkHash={card.artwork_hash} playlist={card.source.type === 'playlist'}
            favorites={card.source.type === 'playlist' && card.source.playlistId === -1}
            playback={getPlayback(card)} onOpen={() => onOpen(card)} onPlay={() => onPlay(card)} />
        )} />
      )}
    </HomeSection>
  )
}
