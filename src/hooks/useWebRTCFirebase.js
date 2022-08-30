import { useCallback, useEffect, useState } from "react";
import { doc, collection, setDoc, addDoc, getDoc, onSnapshot, deleteDoc, getDocs, query } from  "firebase/firestore";
import useWebRTC from "./useWebRTC";

const useWebRTCFirebase = ({ db, participantId }) => {
    const [roomId, setRoomId] = useState('');
    const {
        localStream,
        participants,
        hasParticipant,
        addingParticipant,
        joinRoom,
        addParticipant,
        receiveOffer,
        addIceCandidate,
        leaveRoom,
    } = useWebRTC({
        sendOffer: useCallback(async (participantFor, offer) => {
            const callDocRef = doc(db, "calls", roomId);
            const callParticipantsCollectionRef = collection(callDocRef, "participants");
            const callParticipantDocRef = doc(callParticipantsCollectionRef, participantId);
            const callParticipantOffersCollectionRef = collection(callParticipantDocRef, 'offers');
            const callParticipantOffersDoc = doc(callParticipantOffersCollectionRef, participantFor);
            await setDoc(callParticipantOffersDoc, { payload: offer, participantId: participantFor });
            await setDoc(callParticipantDocRef, { participantId })
        }, [roomId, db, participantId]),
        sendAnswer: useCallback(async (participantFor, answer) => {
            const callDocRef = doc(db, "calls", roomId);
            const callParticipantsCollectionRef = collection(callDocRef, "participants");

            const callParticipantForDocRef = doc(callParticipantsCollectionRef, participantFor);

            const callParticipantAnswersCollectionRef = collection(callParticipantForDocRef, 'answers');
            const callParticipantAnswersDoc = doc(callParticipantAnswersCollectionRef, participantId);
            await setDoc(callParticipantAnswersDoc, { payload: answer, participantId });

            const callParticipantDocRef = doc(callParticipantsCollectionRef, participantId);
            await setDoc(callParticipantDocRef, { participantId });
        }, [roomId, db, participantId]),
        onLeave: () => {},
        onIceCandidate: async (participantFor, iceCandidate) => {
            // send ice candidate to firestore
            const callDocRef = doc(db, "calls", roomId);
            const callParticipantsCollectionRef = collection(callDocRef, "participants");
            const callParticipantForDocRef = doc(callParticipantsCollectionRef, participantFor);
            const iceCandidatesForRef = collection(doc(collection(callParticipantForDocRef, "iceCandidates"), participantId), "candidates");
            await addDoc(iceCandidatesForRef, iceCandidate);
        },
    })


    useEffect(() => {
        let unsub;
        let unsubAnswers;
        let unsubOffers;
        let iceCandidateSubscriptions = [];
        const initWebrtc = async () => {
            if (!roomId) {
                return;
            }
            const callDoc = doc(db, 'calls', roomId);
            const answersQuery = query(collection(callDoc, 'participants', participantId, 'answers'))
            unsubAnswers = onSnapshot(answersQuery, (answersSnapshot) => {
                answersSnapshot.forEach(answer => {
                    const { payload, participantId: participantFrom } = answer.data();
                    if (hasParticipant(participantFrom)) {
                        receiveOffer(participantFrom, payload);
                    } else if (!hasParticipant(participantFrom) && participantFrom !== participantId && !addingParticipant(participantFrom)) {
                        addParticipant({ participantId: participantFrom, incomingOffer: payload });
                    }
                })
            });
            iceCandidateSubscriptions = participants.map(({ id }) => {
                const candidateQueryForId = query(collection(callDoc, 'participants', participantId, 'iceCandidates', id, 'candidates'));
                return onSnapshot(candidateQueryForId, (candidateSnapshot) => {
                    candidateSnapshot.forEach(candidate => {
                        if (hasParticipant(id)) {
                            addIceCandidate(id, candidate.data());
                        } else {
                            console.log('received ice candidates for non-added participant', id);
                        }
                    })
                })
            })
            const participantQuery = query(collection(callDoc, 'participants'));
            unsubOffers = onSnapshot(participantQuery, (participantSnapshot) => {
                participantSnapshot.forEach(async p => {
                    const participant = p.data();
                    const offerForMe = await getDoc(doc(callDoc, 'participants', participant.participantId, 'offers', participantId));
                    if (offerForMe.exists() && !hasParticipant(participant.participantId) && !addingParticipant(participant.participantId)) {
                        addParticipant({ participantId: participant.participantId, incomingOffer: offerForMe.data().payload });
                    }
                })
            })
        }
        initWebrtc();
        return () => {
            if (unsub) {
                unsub();
            }
            if (unsubAnswers) {
                unsubAnswers();
            }
            if (unsubOffers) {
                unsubOffers();
            }
            if (iceCandidateSubscriptions.length) {
                iceCandidateSubscriptions.forEach(us => us());
            }
        }
    }, [addParticipant, hasParticipant, receiveOffer, addIceCandidate, addingParticipant, roomId, participantId, db, participants]);

    return {
        localStream,
        participants,
        createRoom: useCallback(async () => {
            const callsCollectionRef = collection(db, "calls");
            const newCall = await addDoc(callsCollectionRef, {});
            await setDoc(doc(callsCollectionRef, newCall.id, 'participants', participantId), { participantId });
            setRoomId(newCall.id);
        }, [db, participantId]),
        joinRoom: useCallback(async () => {
            const callDoc = doc(db, 'calls', roomId);
            const callParticipantsCollectionRef = collection(callDoc, "participants");
            const participantCollectionSnapshot = await getDocs(callParticipantsCollectionRef)
            const pids = [];
            participantCollectionSnapshot.forEach(p => p.data().id !== 'init' && pids.push(p.data().participantId));

            const callParticipantForDocRef = doc(callParticipantsCollectionRef, participantId);
            const myParticipantDoc = await getDoc(callParticipantForDocRef);
            if (participantCollectionSnapshot.size === 1 && !myParticipantDoc.exists()) {
                const participantsNotMe = pids.filter(pid => pid !== participantId);
                const initParticipantId = participantsNotMe[0];
                const initParticipantDocRef = doc(callParticipantsCollectionRef, initParticipantId, 'offers', 'init');
                const init = await getDoc(initParticipantDocRef);

                if (init.exists()) {
                    const callParticipantOffersDoc = doc(callParticipantsCollectionRef, initParticipantId, 'offers', participantId);
                    // move offer doc from 'init' to this participant's id space
                    await setDoc(callParticipantOffersDoc, init.data());
                    await deleteDoc(initParticipantDocRef);
                    // get the init ice candidates
                    const iceCandidatesDocs = await getDocs(collection(callDoc, 'participants', 'init', 'iceCandidates', initParticipantId, 'candidates'));
                    const iceCandidates = iceCandidatesDocs.docs.map(doc => doc.data());
                    // move ice candidates to the right spot
                    await Promise.all(iceCandidates.map(async d => {
                        await addDoc(collection(callDoc, 'participants', participantId, 'iceCandidates', initParticipantId, 'candidates'), d);
                    }));
                    // clean up init
                    await deleteDoc(doc(callDoc, 'participants', 'init'));

                    await joinRoom(pids.map(pid => ({ participantId: pid, incomingOffer: init.data().payload, iceCandidates })));
                    return;
                }
            }
            await joinRoom(pids.filter(pid => pid !== participantId).map(pid => ({ participantId: pid })));
        }, [db, joinRoom, participantId, roomId]),
        leaveRoom: useCallback(leaveRoom, [leaveRoom]),
        roomId,
        setRoomId,
    };
}

export default useWebRTCFirebase
