// Peer-to-peer voice call between host and guest during an online match.
// Signaling (offer/answer/ICE candidates) rides through the same Firebase
// room object everything else uses - no separate signaling server. Only
// makes sense for a real two-person room, never against the AI.
const VoiceChat = (() => {
  // STUN alone fails to connect across a fair number of real-world NATs
  // (symmetric NAT, some mobile carriers) - openrelay.metered.ca is a
  // known public free TURN relay used as a fallback so those calls still
  // connect instead of silently never reaching "connected".
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];

  let pc = null;
  let localStream = null;
  let active = false;
  let roomRef = null;
  let candidateListenerRef = null;

  // Set by app.js to surface connection-state changes ('connected',
  // 'disconnected', 'failed', ...) as user-facing notifications - the call
  // used to just look "on" forever even after it silently died.
  let onStateChange = null;

  function cleanup() {
    if (pc) {
      pc.close();
      pc = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (candidateListenerRef) {
      candidateListenerRef.off();
      candidateListenerRef = null;
    }
    const audioEl = document.getElementById('remote-voice-audio');
    if (audioEl) audioEl.srcObject = null;
    active = false;
  }

  // roomId + myRole ('host' | 'guest'); returns a promise resolving to the
  // new active state (true = call started, false = call ended).
  async function toggle(roomId, myRole, isAiMode) {
    if (isAiMode || (myRole !== 'host' && myRole !== 'guest')) {
      return Promise.reject(new Error('VOICE_NOT_AVAILABLE'));
    }

    if (active) {
      cleanup();
      return false;
    }

    roomRef = firebase.database().ref('dond_rooms/' + roomId + '/webrtc');

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      // Rethrow with the original name intact (NotAllowedError/NotFoundError/...)
      // so the caller can show a specific message instead of a generic failure.
      throw err;
    }

    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.ontrack = (event) => {
      const audioEl = document.getElementById('remote-voice-audio');
      if (!audioEl) return;
      audioEl.srcObject = event.streams[0];
      // Some browsers block programmatic playback of a track attached
      // outside a user-gesture call stack (this fires async from
      // ontrack) even with autoplay set - call play() explicitly and
      // surface the failure instead of leaving silent "connected" audio.
      audioEl.play().catch(() => {
        if (onStateChange) onStateChange('audio-blocked');
      });
    };

    pc.oniceconnectionstatechange = () => {
      if (pc && onStateChange) onStateChange(pc.iceConnectionState);
    };

    const myCandidatesPath = myRole === 'host' ? 'hostCandidates' : 'guestCandidates';
    const theirCandidatesPath = myRole === 'host' ? 'guestCandidates' : 'hostCandidates';

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        roomRef.child(myCandidatesPath).push(event.candidate.toJSON());
      }
    };

    candidateListenerRef = roomRef.child(theirCandidatesPath);
    candidateListenerRef.on('child_added', (snap) => {
      const candidate = snap.val();
      if (candidate && pc) {
        pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }
    });

    if (myRole === 'host') {
      // Host always initiates: clear any stale signaling data from a
      // previous call first so an old offer/answer can't confuse this one.
      await roomRef.remove();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await roomRef.child('offer').set({ type: offer.type, sdp: offer.sdp });

      roomRef.child('answer').on('value', async (snap) => {
        const answer = snap.val();
        if (answer && pc && !pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        }
      });
    } else {
      roomRef.child('offer').on('value', async (snap) => {
        const offer = snap.val();
        if (offer && pc && !pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await roomRef.child('answer').set({ type: answer.type, sdp: answer.sdp });
        }
      });
    }

    active = true;
    return true;
  }

  return {
    toggle,
    cleanup,
    set onStateChange(fn) { onStateChange = fn; }
  };
})();
