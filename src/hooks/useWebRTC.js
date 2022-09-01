import { useCallback, useEffect, useRef, useState } from "react";

// Initialize WebRTC
const servers = {
    iceServers: [
        {
            urls: [
                "stun:stun1.l.google.com:19302",
                "stun:stun2.l.google.com:19302",
            ],
        },
    ],
    iceCandidatePoolSize: 10,
};


// init with your own userId to send the correct offers
const useWebRTC = ({
    // participantId,
    sendOffer = () => {},
    sendAnswer = () => {},
    sendIceCandidate = () => {},
    onLeave = () => {},
    onParticipantRemoved = () => {},
    onAnswerReceived = () => {},
}) => {
    const [localStream, setLocalStream] = useState(null);
    const [localScreenCaptureStream, setLocalScreenCaptureStream] = useState(null);
    const [sharingScreen, setSharingScreen] = useState(null);
    const [screenShareEnded, setScreenShareEnded] = useState(false);
    const [rtcPeers, setRtcPeers] = useState({});
    const peerAddedRef = useRef({});
    const peerAnswerReceived = useRef({});
    const joinedRoom = useRef({ joined: true });

    const receiveAnswer = useCallback(async (participantId, offer) => {
        const pc = rtcPeers[participantId].peerConnection;
        if (pc.signalingState === 'stable' || peerAnswerReceived.current[participantId]) {
            return;
        }
        peerAnswerReceived.current[participantId] = true;
        const remoteOffer = new RTCSessionDescription(offer);
        await pc.setRemoteDescription(remoteOffer);
        onAnswerReceived(participantId);
    }, [rtcPeers, onAnswerReceived]);

    const removeParticipant = useCallback((participantId) => {
        setRtcPeers((currentPeers) => {
            const peersCopy = {
                ...currentPeers,
            };
            if (peersCopy[participantId]) {
                const { peerConnection, stream } = peersCopy[participantId];
                delete peersCopy[participantId];
                peerConnection.close();
                stream.getTracks().forEach((track) => {
                  track.stop();
                });
            }
            return peersCopy;
        });
        delete peerAddedRef.current[participantId]
        delete peerAnswerReceived.current[participantId]
        onParticipantRemoved(participantId);
    }, [onParticipantRemoved]);

    // create a peer connection for the participant by an id
    const addParticipant = useCallback(async ({ participantId, incomingOffer, iceCandidates }) => {
        // don't try to add participant multiple times
        if (peerAddedRef.current[participantId] || !joinedRoom.current.joined) {
            return;
        }
        peerAddedRef.current[participantId] = true;

        // add user's local stream to the new peer connection
        const pc = new RTCPeerConnection(servers);
        localStream.getTracks().forEach((track) => {
            pc.addTrack(track, localStream);
        });

        // setup stream for remote user's stream data
        const remoteStream = new MediaStream();
        pc.ontrack = (event) => {
            event.streams[0].getTracks().forEach((track) => {
                remoteStream.addTrack(track);
            });
        };

        // when the peer connection gets an ice candidate, handle the event
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sendIceCandidate(participantId, event.candidate.toJSON());
            }
        };

        pc.onconnectionstatechange = (ev) => {
            switch(pc.connectionState) {
                case "disconnected":
                    removeParticipant(participantId);
                    break;
                default:
            }
        }

        // if this participant was added with an offer already, set up the connection with it
        if (incomingOffer) {
            const incomingRtcSession = new RTCSessionDescription(incomingOffer);
            await pc.setRemoteDescription(incomingRtcSession);
            const answerDescription = await pc.createAnswer();
            await pc.setLocalDescription(answerDescription);
            const answer = {
                sdp: answerDescription.sdp,
                type: answerDescription.type,
            };
            sendAnswer(
                participantId,
                answer,
            )
        } else {
            // send offer for participant
            const offerDescription = await pc.createOffer();
            await pc.setLocalDescription(offerDescription);
            const offer = {
                sdp: offerDescription.sdp,
                type: offerDescription.type,
            };
            sendOffer(
                participantId,
                offer,
            );
        }

        if (iceCandidates) {
            iceCandidates.forEach(c => pc.addIceCandidate(c));
        }

        setRtcPeers((currentRtcPeers) => ({
            ...currentRtcPeers,
            [participantId]: {
                peerConnection: pc,
                stream: remoteStream,
            }
        }));
        return {
            peerConnection: pc,
            stream: remoteStream,
        };
    }, [localStream, sendIceCandidate, sendOffer, sendAnswer, removeParticipant]);

    const addIceCandidate = useCallback((participantId, data) => {
        if (!joinedRoom.current.joined) return;
        const candidate = new RTCIceCandidate(
            data
        );
        const pc = rtcPeers[participantId].peerConnection;
        pc.addIceCandidate(candidate);
    }, [rtcPeers])

    // join a room with a list of participants
    // participants: [participantIds]
    const joinRoom = useCallback(async (participants) => {
        joinedRoom.current.joined = true;
        return Promise.all(participants.map(addParticipant))
    }, [addParticipant]);

    // close all peer connections in a room
    const leaveRoom = useCallback(async () => {
        joinedRoom.current.joined = false;
        for (const participantId in rtcPeers) {
            removeParticipant(participantId);
        }
        onLeave();
    }, [onLeave, removeParticipant, rtcPeers]);

    const hasParticipant = useCallback((participantId) => {
        return !!rtcPeers[participantId];
    }, [rtcPeers]);

    const addingParticipant = useCallback((participantId) => {
        return peerAddedRef.current[participantId]
    }, [])

    const shareScreen = useCallback(async ({ constraints = { video: true, audio: true }, options = {} } = {}) => {
        if (!joinedRoom.current.joined) return;
        try {
            const screenCaptureStream = await navigator.mediaDevices.getDisplayMedia(constraints);
            screenCaptureStream.getVideoTracks()[0]?.addEventListener('ended', (_ev) => {
                setSharingScreen(false);
                setScreenShareEnded(true);
            })
            screenCaptureStream.getAudioTracks()[0]?.addEventListener('ended', (_ev) => {
                setSharingScreen(false);
                setScreenShareEnded(true);
            })
            setLocalScreenCaptureStream(screenCaptureStream);
            setSharingScreen(options);
        } catch (e) {
            console.error(e);
        }
    }, []);

    const endScreenShare = useCallback(async () => {
        setSharingScreen(false);
        setScreenShareEnded(true);
    }, []);

    useEffect(() => {
        const replaceTracks = (incomingStream) => {
            const screenTrack = incomingStream.getVideoTracks()[0];
            const audioTrack = incomingStream.getAudioTracks()[0];
            Object.keys(rtcPeers).forEach((peerId) => {
                const { peerConnection } = rtcPeers[peerId]
                peerConnection.getSenders().forEach(sender => {
                    switch (sender.track.kind) {
                        case 'audio':
                            if (audioTrack && !sharingScreen?.suppressAudio) {
                                sender.replaceTrack(audioTrack);
                            }
                            break;
                        case 'video':
                            if (screenTrack && !sharingScreen?.suppressVideo) {
                                sender.replaceTrack(screenTrack);
                            }
                            break;
                        default:
                            break;
                    }
                })
            })
        };
        if (sharingScreen && localScreenCaptureStream) {
            replaceTracks(localScreenCaptureStream);
        } else if (screenShareEnded) {
            replaceTracks(localStream);
            setScreenShareEnded(false);
        }
    }, [rtcPeers, localStream, localScreenCaptureStream, sharingScreen, screenShareEnded]);

    useEffect(() => {
        const teardownPeerListeners = Object.keys(rtcPeers).map((pid) => {
            const { peerConnection } = rtcPeers[pid];

            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    sendIceCandidate(pid, event.candidate.toJSON());
                }
            };

            peerConnection.onconnectionstatechange = (ev) => {
                switch(peerConnection.connectionState) {
                    case "disconnected":
                        removeParticipant(pid);
                        break;
                    default:
                }
            }

            return () => {
                peerConnection.onicecandidate = () => {};
                peerConnection.onconnectionstatechange = () => {};
            }
        });
        return () => {
            teardownPeerListeners.forEach(t => t());
        }
    }, [rtcPeers, removeParticipant, sendIceCandidate]);

    useEffect(() => {
        const initStream = async () => {
            const userStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true,
            });
            setLocalStream(userStream)
        }
        initStream();
    }, []);

    return {
        localStream,
        participants: Object.keys(rtcPeers).map(peerId => ({ stream: rtcPeers[peerId].stream, id: peerId })),
        shareScreen,
        endScreenShare,
        hasParticipant,
        addingParticipant,
        joinRoom,
        addParticipant,
        removeParticipant,
        receiveAnswer,
        addIceCandidate,
        leaveRoom,
    };
}

export default useWebRTC
