import { useCallback, useEffect, useState } from "react";
import { doc, collection, setDoc, addDoc, getDoc, onSnapshot, deleteDoc, getDocs, query } from  "firebase/firestore";
import useWebRTC from "./useWebRTC";

const useWebRTCFirebase = ({ db, participantId }) => {
    const [roomId, setRoomId] = useState('');
    const {
        localStream,
        participants,
        shareScreen,
        endScreenShare,
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
        onLeave: async () => {
            const callDocRef = doc(db, "calls", roomId);

            const callParticipantsCollectionRef = collection(callDocRef, "participants");
            const participantCollectionSnapshot = await getDocs(callParticipantsCollectionRef)
            const pids = [];
            participantCollectionSnapshot.forEach(p => pids.push(p.data().participantId));
            await Promise.all(pids.map(async pid => {
                if (pid === participantId) return;
                const answersForMeRef = doc(callParticipantsCollectionRef, pid, 'answers', participantId);
                await deleteDoc(answersForMeRef);
                const offersForMeRef = doc(callParticipantsCollectionRef, pid, 'offers', participantId);
                await deleteDoc(offersForMeRef);
                const myAnswersRef = doc(callParticipantsCollectionRef, participantId, 'answers', pid);
                await deleteDoc(myAnswersRef);
                const myOffersRef = doc(callParticipantsCollectionRef, participantId, 'offers', pid);
                await deleteDoc(myOffersRef);

                const iceCandidatesForMeRef = collection(callParticipantsCollectionRef, pid, 'iceCandidates', participantId, 'candidates');
                const iceCandidatesForMe = await getDocs(iceCandidatesForMeRef);
                const iceCandidateDeletes = [];
                iceCandidatesForMe.forEach(c => iceCandidateDeletes.push(
                    deleteDoc(doc(iceCandidatesForMeRef, c.id))
                ));
                await Promise.all(iceCandidateDeletes);
                await deleteDoc(doc(callParticipantsCollectionRef, pid, 'iceCandidates', participantId));

                const myIceCandidatesRef = collection(callParticipantsCollectionRef, participantId, 'iceCandidates', pid, 'candidates');
                const myIceCandidates = await getDocs(myIceCandidatesRef);
                const myIceCandidatesDeletes = [];
                myIceCandidates.forEach(c => myIceCandidatesDeletes.push(
                    deleteDoc(doc(myIceCandidatesRef, c.id))
                ));
                await Promise.all(iceCandidateDeletes);
                await deleteDoc(doc(callParticipantsCollectionRef, participantId, 'iceCandidates', pid))
            }))
            await deleteDoc(doc(callDocRef, 'participants', participantId));
            setRoomId('');
        },
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
        shareScreen,
        endScreenShare,
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
            participantCollectionSnapshot.forEach(p => pids.push(p.data().participantId));
            await joinRoom(pids.filter(pid => pid !== participantId).map(pid => ({ participantId: pid })));
        }, [db, joinRoom, participantId, roomId]),
        leaveRoom,
        roomId,
        setRoomId,
    };
}

export default useWebRTCFirebase
