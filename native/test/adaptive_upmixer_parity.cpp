#include "adaptive_upmixer.h"

#include <iostream>
#include <iterator>
#include <cstring>
#include <string>
#include <vector>

int main(int argc, char** argv) {
    std::cin.sync_with_stdio(false);
    std::cout.sync_with_stdio(false);
    std::vector<char> bytes(
        (std::istreambuf_iterator<char>(std::cin)),
        std::istreambuf_iterator<char>());
    if (bytes.size() % (sizeof(float) * 2) != 0) return 2;

    const size_t frames = bytes.size() / (sizeof(float) * 2);
    std::vector<float> input(frames * 2);
    std::memcpy(input.data(), bytes.data(), bytes.size());
    const std::vector<Astra::Upmix::SpeakerRole> roles = {
        Astra::Upmix::SpeakerRole::FrontLeft,
        Astra::Upmix::SpeakerRole::FrontRight,
        Astra::Upmix::SpeakerRole::FrontCenter,
        Astra::Upmix::SpeakerRole::Lfe,
        Astra::Upmix::SpeakerRole::SideLeft,
        Astra::Upmix::SpeakerRole::SideRight,
    };
    const int algorithmCode = argc > 1 ? std::stoi(argv[1]) : 0;
    Astra::Upmix::AdaptiveUpmixer upmixer({
        48000.0f,
        roles,
        static_cast<Astra::Upmix::Algorithm>(algorithmCode),
    });
    std::vector<float> output(frames * roles.size(), 0.0f);
    for (size_t offset = 0; offset < frames; offset += 128) {
        const size_t count = std::min<size_t>(128, frames - offset);
        upmixer.process(input.data() + offset * 2, output.data() + offset * roles.size(), count);
    }
    std::cout.write(reinterpret_cast<const char*>(output.data()),
                    static_cast<std::streamsize>(output.size() * sizeof(float)));
    return std::cout ? 0 : 3;
}
