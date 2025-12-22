'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import { invoke } from "@tauri-apps/api/core";

import { create, writeTextFile, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';


interface RemoveSentenceConfig {
  id: number;
  text: string;
}


export function useCustomRemoveSentenceState(p0?: never[]): [RemoveSentenceConfig[] | undefined, (newValue: RemoveSentenceConfig[]) => void] {
    const [value, setValue] = useState<RemoveSentenceConfig[]>();
    useEffect(() => {
        return () => {
        // do cleanup
        };
    }, [value]);

    const customSetValue = useCallback((newValue:RemoveSentenceConfig[]) => {
        setValue(newValue);
        invoke<string[]>("set_removes", { removes: newValue })
            .then((s) => {
                //console.log("Update highlights:",s);
                saveRemoveSentenceToFile(newValue);
            }).catch((err: unknown) => {
                console.error(err);
            });
    }, []);
    // Sauvegarde des surlignages dans un fichier JSON local
    async function saveRemoveSentenceToFile(removeSentenceToSave: RemoveSentenceConfig[]) {
        const filePath = 'remove_sentence_settings.json';
        try {
            await writeTextFile(
            filePath,
            JSON.stringify(removeSentenceToSave, null, 2), { baseDir: BaseDirectory.AppConfig }
            );
        } catch (e) {
            console.log('Erreur lors de la sauvegarde : ' + e);
        }
    }
    return [value, customSetValue];
}

const RemoveSentenceSettings: React.FC = () => {
    const [removeSentences, setRemoveSentences] = useCustomRemoveSentenceState([]);
    // Chargement des surlignages depuis le fichier JSON au démarrage
    async function loadRemoveSentencesFromFile() {
        const filePath = 'remove_sentence_settings.json';
        try {
            const result = await readTextFile(filePath, { baseDir: BaseDirectory.AppConfig });
            const highlights = JSON.parse(result);
            let tmpArr: RemoveSentenceConfig[] = [];
            highlights.forEach((h:RemoveSentenceConfig) => tmpArr.push({ id: h.id, text: h.text }));
            setRemoveSentences(tmpArr);
        } catch (e) {
            console.log('Erreur lors du chargement : ' + e);
        }  
    }
    useEffect(() => {
        loadRemoveSentencesFromFile();
        console.log("run once");
    }, []);
    const handleAddRemoveSentence = async () => {
        if(removeSentences == undefined) {
            setRemoveSentences([{ id: Date.now(), text: '' }]);
            return;
        };
        setRemoveSentences([...removeSentences, { id: Date.now(), text: '' }]);
    };

    const handleRemoveRemoveSentence = (id: number) => {
        if(removeSentences == undefined) return;
        setRemoveSentences(removeSentences.filter(f => f.id !== id));
    };

    const handleRemoveSentenceChange = (id: number, field: keyof RemoveSentenceConfig, value: string) => {
        if(removeSentences == undefined) return;
        setRemoveSentences(removeSentences.map(f => f.id === id ? { ...f, [field]: value } : f));
    };

    return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="subtitle2">Remove sentence</Typography>
        <IconButton size="small" onClick={handleAddRemoveSentence}>
            <AddIcon />
        </IconButton>
        </Box>
        {removeSentences?.map((filter) => (
        <Box key={filter.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TextField
            size="small"
            placeholder="Filter text"
            value={filter.text}
            onChange={(e) => handleRemoveSentenceChange(filter.id, 'text', e.target.value)}
            sx={{ flexGrow: 1 }}
            />
            <IconButton size="small" onClick={() => handleRemoveRemoveSentence(filter.id)}>
            <DeleteIcon />
            </IconButton>
        </Box>
        ))}
    </Box>
    );
};

export default RemoveSentenceSettings;

