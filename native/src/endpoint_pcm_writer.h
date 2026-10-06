#pragma once

#include "endpoint_frame_queue.h"

namespace NativePlayback {

enum class EndpointWriteRecovery { Retry, RenderAgain, Abort };
enum class EndpointWriteResult { Complete, Aborted, InvalidFrameCount };

// Submit one rendered block through a possibly partial device writer. render()
// returns the audio prefix length; the remainder is sink-added padding. write()
// takes a frame offset/count and returns accepted frames or a nonpositive result
// for recover(). RenderAgain means the sink and engine were reset together; an
// old block must never be resubmitted after that rollback. Callbacks own device
// errors/waits/cancellation. No allocation or extra PCM copying occurs here.
template<class Render, class Write, class Recover>
EndpointWriteResult WriteEndpointPcm(
    EndpointFrameQueue& queue, size_t requestedFrames, Render render, Write write, Recover recover
) {
    size_t audioFrames = render();
    if (audioFrames > requestedFrames) return EndpointWriteResult::InvalidFrameCount;
    size_t written = 0;
    while (written < requestedFrames) {
        const auto result = write(written, requestedFrames - written);
        if (result > 0) {
            const size_t accepted = static_cast<size_t>(result);
            if (accepted > requestedFrames - written) return EndpointWriteResult::InvalidFrameCount;
            const size_t acceptedAudio = written < audioFrames ? std::min(accepted, audioFrames - written) : 0;
            if (!queue.append(accepted, acceptedAudio)) return EndpointWriteResult::InvalidFrameCount;
            written += accepted;
            continue;
        }
        switch (recover(result)) {
            case EndpointWriteRecovery::Retry: break;
            case EndpointWriteRecovery::RenderAgain:
                if (queue.queuedFrames()) return EndpointWriteResult::InvalidFrameCount;
                written = 0;
                audioFrames = render();
                if (audioFrames > requestedFrames) return EndpointWriteResult::InvalidFrameCount;
                break;
            case EndpointWriteRecovery::Abort: return EndpointWriteResult::Aborted;
        }
    }
    return EndpointWriteResult::Complete;
}

} // namespace NativePlayback
